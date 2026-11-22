'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');


const STEALTH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-search-engine-choice-screen',
  '--hide-crash-restore-bubble',
  '--lang=en-US',
  '--start-maximized',
];

const IGNORED_DEFAULT_ARGS = [
  '--enable-automation',
  '--disable-extensions',
  '--disable-component-extensions-with-background-pages',
  '--use-angle=swiftshader',
  '--use-gl=angle',
];

const BROWSER_CANDIDATES = [
  {
    channel: 'chrome',
    paths: [
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ],
  },
  {
    channel: 'msedge',
    paths: [
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ],
  },
];

if (process.platform === 'linux') {
  BROWSER_CANDIDATES.push(
    {
      channel: 'chrome',
      paths: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'],
    },
    {
      channel: 'msedge',
      paths: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/opt/microsoft/msedge/msedge'],
    },
    {
      // Chromium has no Playwright channel; it must be launched by executablePath.
      channel: null,
      paths: ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'],
    },
  );
}

function resolveBrowser() {
  const forced = process.env.BROWSER_CHANNEL;
  if (forced) return { channel: forced === 'chromium' ? null : forced, executablePath: null };
  for (const candidate of BROWSER_CANDIDATES) {
    const found = candidate.paths.find((p) => p && fs.existsSync(p));
    if (found) return { channel: candidate.channel, executablePath: candidate.channel ? null : found };
  }
  return { channel: null, executablePath: null };
}

function resolveChannel() {
  return resolveBrowser().channel;
}

function installStealth(config) {
  const locale = (config && config.locale) || 'en-US';
  const baseLanguage = locale.split('-')[0];
  const languages = locale === baseLanguage ? [locale] : [locale, baseLanguage];

  const safe = (fn) => {
    try {
      fn();
    } catch (e) {}
  };

  safe(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });
  });

  safe(() => {
    if (!window.chrome) {
      Object.defineProperty(window, 'chrome', {
        value: { runtime: { connect: () => {}, sendMessage: () => {}, id: undefined } },
        writable: true,
        configurable: true,
      });
    } else if (!window.chrome.runtime) {
      Object.defineProperty(window.chrome, 'runtime', {
        value: { connect: () => {}, sendMessage: () => {}, id: undefined },
        writable: true,
        configurable: true,
      });
    }
  });

  safe(() => {
    Object.defineProperty(navigator, 'language', { get: () => locale, configurable: true });
    Object.defineProperty(navigator, 'languages', { get: () => languages.slice(), configurable: true });
  });

  safe(() => {
    if (typeof navigator.plugins === 'object' && navigator.plugins.length === 0) {
      const mimeTypes = [
        { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
        { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
      ];
      const definitions = [
        { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      ];

      const plugins = definitions.map((definition) => {
        const types = mimeTypes.map((mime) => ({
          type: mime.type,
          suffixes: mime.suffixes,
          description: mime.description,
        }));
        return {
          name: definition.name,
          filename: definition.filename,
          description: definition.description,
          length: types.length,
          mimeTypes: types,
          item: (index) => types[index] || null,
          namedItem: (type) => types.find((mime) => mime.type === type) || null,
        };
      });

      const pluginArray = {
        length: plugins.length,
        item: (index) => plugins[index] || null,
        namedItem: (name) => plugins.find((plugin) => plugin.name === name) || null,
        refresh: () => {},
      };
      plugins.forEach((plugin, index) => {
        pluginArray[index] = plugin;
      });

      Object.defineProperty(navigator, 'plugins', { get: () => pluginArray, configurable: true });

      const mimeArray = {
        length: mimeTypes.length,
        item: (index) => mimeTypes[index] || null,
        namedItem: (type) => mimeTypes.find((mime) => mime.type === type) || null,
      };
      mimeTypes.forEach((mime, index) => {
        mimeArray[index] = mime;
      });
      Object.defineProperty(navigator, 'mimeTypes', { get: () => mimeArray, configurable: true });
    }
  });

  safe(() => {
    if (navigator.hardwareConcurrency === undefined) {
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8, configurable: true });
    }
    if (navigator.deviceMemory === undefined) {
      Object.defineProperty(navigator, 'deviceMemory', { get: () => 8, configurable: true });
    }
    if (navigator.pdfViewerEnabled === undefined) {
      Object.defineProperty(navigator, 'pdfViewerEnabled', { get: () => true, configurable: true });
    }
  });

  safe(() => {
    const maskSoftwareRenderer = (proto) => {
      if (!proto || typeof proto.getParameter !== 'function') return;
      if (proto.getParameter.__stealth) return;
      const original = proto.getParameter;
      const patched = function (parameter) {
        const value = original.call(this, parameter);
        if ((parameter === 37445 || parameter === 37446) && typeof value === 'string') {
          if (/swiftshader|llvmpipe|software|basic render|mesa offscreen/i.test(value)) {
            return parameter === 37445
              ? 'Google Inc. (NVIDIA)'
              : 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11-27.21.14.6603)';
          }
        }
        return value;
      };
      patched.__stealth = true;
      proto.getParameter = patched;
    };

    maskSoftwareRenderer(window.WebGLRenderingContext && window.WebGLRenderingContext.prototype);
    maskSoftwareRenderer(window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype);
  });

  safe(() => {
    if (window.__playwright__binding__) delete window.__playwright__binding__;
    if (window.__pwInitScripts) delete window.__pwInitScripts;
    if (window.__playwright_target__) delete window.__playwright_target__;
  });
}


const attachedBrowsers = new WeakMap();

// Chromium writes this endpoint inside the profile when launched with port 0.
// The browser UUID prevents a recycled port from attaching to another profile.
async function attachProfile(userDataDir) {
  try {
    const file = await fs.promises.readFile(path.join(userDataDir, 'DevToolsActivePort'), 'utf8');
    const [port, endpoint] = file.trim().split(/\r?\n/);
    if (!/^\d+$/.test(port) || !/^\/devtools\/browser\/[a-f0-9-]+$/i.test(endpoint)) return null;
    const browser = await chromium.connectOverCDP('ws://127.0.0.1:' + port + endpoint, { timeout: 2000 });
    const [context] = browser.contexts();
    if (!context) { await browser.close(); return null; }
    attachedBrowsers.set(context, browser);
    return context;
  } catch { return null; }
}

function tabHost(page) {
  try { return new URL(page.url()).hostname; } catch { return ''; }
}

function providerSignInTab(page, hostname) {
  const host = tabHost(page);
  return (hostname === 'aistudio.google.com' && host === 'accounts.google.com')
    || (hostname === 'chatgpt.com' && ['auth.openai.com', 'accounts.google.com', 'appleid.apple.com'].includes(host));
}

async function selectProviderTab(context, hostname, target, current) {
  const pages = context.pages().filter(page => !page.isClosed());
  const matching = pages.filter(page => tabHost(page) === hostname);
  return matching.find(page => target && page.url() === target)
    || (matching.includes(current) && current)
    || matching[0]
    || pages.find(page => providerSignInTab(page, hostname))
    || pages.find(page => page.url() === 'about:blank')
    || context.newPage();
}

async function releaseProviderContext(context) {
  const attached = attachedBrowsers.get(context);
  if (attached) await attached.close(); // Disconnect this CDP client.
  else await context.close();
}

async function launchStealthContext(userDataDir, options = {}) {
  const attached = await attachProfile(userDataDir);
  if (attached) return attached;
  const resolved = resolveBrowser();
  const channel = options.channel !== undefined ? options.channel : resolved.channel;
  const executablePath = options.channel !== undefined ? null : resolved.executablePath;
  const locale = options.locale || process.env.STEALTH_LOCALE || 'en-US';
  const headless = false; 

  let context;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless,
      channel: channel || undefined,
      executablePath: executablePath || undefined,
      viewport: options.viewport || null,
      locale,
      acceptDownloads: true,
      // Opt-in only (e.g. containers / restricted user namespaces on Linux).
      chromiumSandbox: process.env.MAGNUM_NO_SANDBOX !== '1',
      args: [...STEALTH_ARGS, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'],
      ignoreDefaultArgs: IGNORED_DEFAULT_ARGS,
    });
  } catch (err) {
    if (!channel && !executablePath && /Executable doesn't exist|playwright install/i.test(String(err && err.message))) {
      throw new Error(
        'No Chrome, Edge or Chromium found. Install one, or run: npx playwright install chromium\n' + err.message
      );
    }
    if (/SingletonLock|ProcessSingleton|profile.*in use|user data directory is already in use/i.test(err.message)) {
      throw new Error('The MagNum provider profile is in use. Close the window using ' + userDataDir + ' and choose Reconnect.');
    }
    throw err;
  }

  await context.addInitScript(installStealth, { locale });

  if (process.env.STEALTH_DEBUG === '1') {
    console.log(`[stealth] channel=${channel || 'playwright-chromium'} locale=${locale} headless=${headless}`);
  }

  return context;
}

module.exports = { providerSignInTab, selectProviderTab, releaseProviderContext, launchStealthContext, installStealth, resolveChannel, resolveBrowser };
