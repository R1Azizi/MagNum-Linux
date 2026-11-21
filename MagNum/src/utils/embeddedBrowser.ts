import { Webview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { LogicalPosition, LogicalSize } from '@tauri-apps/api/dpi';
import { invoke } from '@tauri-apps/api/core';

export interface EmbeddedRect { x: number; y: number; width: number; height: number; }

class EmbeddedBrowserManager {
  private webview: Webview | null = null;
  private creating: Promise<Webview> | null = null;
  public isVisible = false;
  private currentRect: EmbeddedRect = { x: 0, y: 0, width: 440, height: 600 };
  private activeUrl: string = 'https://www.google.com/?hl=fa';
  private resizeSuspended = false;
  private backendPort: number = 5454;

  public setPort(port: number): void {
    if (port > 0) this.backendPort = port;
  }

  private async getPort(): Promise<number> {
    if (this.backendPort === 5454) {
      try {
        const port = await invoke<number>('get_backend_port');
        if (port) this.backendPort = port;
      } catch {}
    }
    return this.backendPort;
  }

  async ensure(): Promise<Webview> {
    // Always re-validate the cached reference; the webview may have been closed
    // (by user or by us) and reusing a dead reference causes silent failures.
    if (this.webview) {
      try {
        // Probe: invoking an IPC method on a destroyed webview rejects.
        await this.webview.setPosition(new LogicalPosition(0, 0));
        return this.webview;
      } catch {
        this.webview = null;
      }
    }

    // بازیابی رفرنس وب‌ویو در صورت وجود
    try {
      const existing = await Webview.getByLabel('magnum-embedded-browser');
      if (existing) {
        this.webview = existing;
        return existing;
      }
    } catch {}

    if (this.creating) return this.creating;

    this.creating = (async () => {
      const win = getCurrentWindow();
      const wv = new Webview(win, 'magnum-embedded-browser', {
        url: this.activeUrl,
        x: Math.max(0, Math.round(this.currentRect.x)),
        y: Math.max(0, Math.round(this.currentRect.y)),
        width: Math.max(10, Math.round(this.currentRect.width)),
        height: Math.max(10, Math.round(this.currentRect.height)),
        focus: false
      } as any);

      await new Promise<void>((resolve, reject) => {
        (wv as any).once('tauri://created', () => resolve()).catch(reject);
        (wv as any).once('tauri://error', (e: any) => reject(e)).catch(reject);
      });

      this.webview = wv;
      return wv;
    })();

    try {
      return await this.creating;
    } finally {
      this.creating = null;
    }
  }

  beginResize(): void {
    this.resizeSuspended = true;
    if (this.webview && this.isVisible) {
      this.webview.hide().catch(() => {});
      this.isVisible = false;
    }
  }

  endResize(): void {
    this.resizeSuspended = false;
  }

  async showIn(rect: EmbeddedRect): Promise<void> {
    this.currentRect = rect;
    if (this.resizeSuspended) return;

    const wv = await this.ensure();
    const rx = Math.max(0, Math.round(rect.x)), ry = Math.max(0, Math.round(rect.y));
    const rw = Math.max(10, Math.round(rect.width)), rh = Math.max(10, Math.round(rect.height));
    await wv.setPosition(new LogicalPosition(rx, ry));
    await wv.setSize(new LogicalSize(rw, rh));
    // Linux: child webviews are stacked in a GtkBox; overlay them via a native command.
    await invoke('place_embedded_browser', { x: rx, y: ry, width: rw, height: rh }).catch(() => {});
    if (!this.isVisible) {
      await wv.show().catch(() => {});
      this.isVisible = true;
    }
    await this.injectPageSync();
  }

  async hide(): Promise<void> {
    this.isVisible = false;
    try {
      if (!this.webview) {
        const existing = await Webview.getByLabel('magnum-embedded-browser');
        if (existing) this.webview = existing;
      }
      if (this.webview) {
        await this.webview.hide().catch(() => {});
      }
    } catch (e) {
      console.warn('[embeddedBrowser] hide error:', e);
    }
  }

  /** Fully destroy the embedded webview (used when the browser panel closes). */
  async close(): Promise<void> {
    this.isVisible = false;
    this.creating = null;
    this.stopSyncLoop();
    try {
      if (!this.webview) {
        const existing = await Webview.getByLabel('magnum-embedded-browser');
        if (existing) this.webview = existing;
      }
      if (this.webview) {
        await (this.webview as any).close?.().catch?.(() => {});
      }
    } catch (e) {
      console.warn('[embeddedBrowser] close error:', e);
    } finally {
      this.webview = null;
    }
  }

  /** Called when the panel opens: ensures a live webview and shows it. */
  async reconnect(rect: EmbeddedRect): Promise<void> {
    // If the cached webview is dead, close it defensively and rebuild.
    if (this.webview) {
      try {
        await this.webview.setPosition(new LogicalPosition(0, 0));
      } catch {
        try { await (this.webview as any).close?.(); } catch {}
        this.webview = null;
      }
    }
    this.creating = null;
    await this.showIn(rect);
  }

  buildUrl(input: string): string {
    let target = String(input || '').trim();
    if (!target) return '';
    if (!/^https?:\/\//i.test(target) && !target.startsWith('about:')) {
      if (target.includes('.') && !target.includes(' ')) target = 'https://' + target;
      else target = `https://www.google.com/search?q=${encodeURIComponent(target)}&hl=fa`;
    }
    return target;
  }

  async navigate(input: string): Promise<void> {
    const url = this.buildUrl(input);
    if (!url) return;
    this.activeUrl = url;

    // ۱. هدایت بدون پرش و مستقیم از طریق بک‌اند (CDP)
    const port = await this.getPort();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/browser-action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'navigate', url: this.activeUrl })
      });
      const data = await res.json();
      if (data && data.ok && data.via !== 'frontend') {
        await this.injectPageSync();
        return;
      }
    } catch {}

    // ۲. روش جایگزین: بازسازی و هدایت مستقیم وب‌ویو
    if (this.webview) {
      try {
        await this.webview.close();
      } catch {}
      this.webview = null;
    }

    const win = getCurrentWindow();
    const newWv = new Webview(win, 'magnum-embedded-browser', {
      url: this.activeUrl,
      x: Math.max(0, Math.round(this.currentRect.x)),
      y: Math.max(0, Math.round(this.currentRect.y)),
      width: Math.max(10, Math.round(this.currentRect.width)),
      height: Math.max(10, Math.round(this.currentRect.height)),
      focus: true
    } as any);

    await new Promise<void>((resolve, reject) => {
      (newWv as any).once('tauri://created', () => resolve()).catch(reject);
      (newWv as any).once('tauri://error', (e: any) => reject(e)).catch(reject);
    });

    this.webview = newWv;
    await invoke('place_embedded_browser', {
      x: Math.max(0, Math.round(this.currentRect.x)), y: Math.max(0, Math.round(this.currentRect.y)),
      width: Math.max(10, Math.round(this.currentRect.width)), height: Math.max(10, Math.round(this.currentRect.height))
    }).catch(() => {});
    if (this.isVisible) {
      await newWv.show().catch(() => {});
    }
    await this.injectPageSync();
  }

  /**
   * ★ Linux Tauri uses WebKitGTK, so the backend cannot CDP-attach to this
   *   webview. Instead we inject a script that pushes (url, title, text) to
   *   /api/browser-sync periodically — which the backend's `read_page` falls
   *   back to whenever CDP is unavailable. This is what lets the agent "see"
   *   the tab the user has opened in the panel.
   */
  private syncUnlisten: (() => void) | null = null;

  /** Register a host-side listener for page snapshots emitted from the webview. */
  private async ensureSyncListener(): Promise<void> {
    if (this.syncUnlisten) return;
    try {
      const { listen } = await import('@tauri-apps/api/event');
      const port = await this.getPort();
      this.syncUnlisten = await listen<any>('magnum-page-sync', async (event) => {
        const p = event.payload || {};
        if (!p || typeof p.url !== 'string') return;
        try {
          await fetch(`http://127.0.0.1:${port}/api/browser-sync`, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: JSON.stringify({ url: p.url, title: p.title || '', text: p.text || '' })
          });
        } catch {}
      });
    } catch (e) {
      console.warn('[embeddedBrowser] sync listener registration failed:', e);
    }
  }

  private stopSyncLoop(): void {
    if (this.syncUnlisten) { try { this.syncUnlisten(); } catch {} this.syncUnlisten = null; }
  }

  async injectPageSync(): Promise<void> {
    if (!this.webview) return;
    await this.ensureSyncListener();
    const port = await this.getPort();
    const js = `(function(){
  if (window.__magnum_sync_started) return;
  window.__magnum_sync_started = true;
  var ENDPOINT = 'http://127.0.0.1:${port}/api/browser-sync';
  function push() {
    try {
      var text = '';
      if (document.body) {
        text = document.body.innerText || '';
        if (!text.trim()) {
          var clone = document.body.cloneNode(true);
          clone.querySelectorAll('script,style,noscript,svg,textarea').forEach(function(n){n.remove();});
          text = (clone.textContent || '').replace(/[ \\t]+/g,' ').replace(/\\n{3,}/g,'\\n\\n').trim();
        }
      }
      var payload = { url: location.href, title: document.title || '', text: text };
      try {
        navigator.sendBeacon(ENDPOINT, new Blob([JSON.stringify(payload)], { type: 'text/plain' }));
      } catch (e) {
        fetch(ENDPOINT, { method: 'POST', mode: 'no-cors', body: JSON.stringify(payload) }).catch(function(){});
      }
    } catch (e) {}
  }
  push();
  setInterval(push, 3000);
  window.addEventListener('load', push);
})();`;
    try {
      await (this.webview as any).eval(js);
    } catch (e) {
      console.warn('[embeddedBrowser] injectPageSync failed:', e);
    }
  }

  async back(): Promise<void> {
    const port = await this.getPort();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/browser-action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'back' })
      });
      const data = await res.json();
      if (data && data.ok) return;
    } catch {}
    await this.navigate('https://www.google.com/?hl=fa');
  }

  async forward(): Promise<void> {
    const port = await this.getPort();
    try {
      await fetch(`http://127.0.0.1:${port}/api/browser-action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'forward' })
      });
    } catch {}
  }

  async reload(): Promise<void> {
    const port = await this.getPort();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/browser-action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reload' })
      });
      const data = await res.json();
      if (data && data.ok) return;
    } catch {}
    if (this.activeUrl) await this.navigate(this.activeUrl);
  }

  getActiveUrl(): string {
    return this.activeUrl;
  }

  getState() {
    return { u: this.activeUrl, t: 'Browser' };
  }

  async syncPageContent(): Promise<void> {
    const port = await this.getPort();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/browser-info`);
      const data = await res.json();
      if (data && data.url && data.url !== 'about:blank') {
        this.activeUrl = data.url;
      }
    } catch {}
  }
}

export const embeddedBrowser = new EmbeddedBrowserManager();
