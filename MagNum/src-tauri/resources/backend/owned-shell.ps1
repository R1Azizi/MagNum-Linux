# Attach this shell to a kill-on-close job before starting user code. The
# handle belongs only to this process. Its children inherit job membership.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class MagnumCommandJob {
    [StructLayout(LayoutKind.Sequential)]
    struct Basic {
        public long processTime, jobTime;
        public uint flags;
        public UIntPtr minWS, maxWS;
        public uint active;
        public UIntPtr affinity;
        public uint priority, scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct Limits {
        public Basic basic;
        public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes;
        public UIntPtr processMem, jobMem, peakProcess, peakJob;
    }
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool SetInformationJobObject(IntPtr job, int kind, ref Limits limits, uint size);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    public static void Attach() {
        var job = CreateJobObject(IntPtr.Zero, null);
        var limits = new Limits();
        limits.basic.flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if (job == IntPtr.Zero ||
            !SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(Limits))) ||
            !AssignProcessToJobObject(job, Process.GetCurrentProcess().Handle))
            throw new Win32Exception(Marshal.GetLastWin32Error());
    }
}
'@
[MagnumCommandJob]::Attach()
$command = $env:MAGNUM_SHELL_INPUT
Remove-Item Env:MAGNUM_SHELL_INPUT
if ($env:MAGNUM_SHELL_MODE -eq 'terminal') {
    $ErrorActionPreference = 'Continue'
    & ([scriptblock]::Create($command))
} else {
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $env:ComSpec
    $info.Arguments = '/d /s /c "' + $command + '"'
    $info.UseShellExecute = $false
    $proc = [System.Diagnostics.Process]::Start($info)
    $proc.WaitForExit()
    exit $proc.ExitCode
}
