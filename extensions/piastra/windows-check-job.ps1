# PiAstra fixed Windows check supervisor.
#
# This is NOT a general-purpose shell. It launches exactly one trusted child (a
# fixed Node command runner) inside a Windows Job Object with
# KILL_ON_JOB_CLOSE. The fixed runner waits on stdin until assigned to the job, so every
# check descendant inherits containment before execution begins. When the job is closed —
# on normal completion, timeout, cancellation or forced termination of the
# supervisor — every remaining process in the job is killed, including orphans
# whose launcher has already exited.
#
# The target command travels as base64 JSON in the PIASTRA_CHECK_JOB
# environment variable and is never interpolated into a command line. The job
# handle is made non-inheritable so no descendant can keep the job object alive
# after the supervisor exits.

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

function Fail-Closed([string]$Message) {
    try { [Console]::Error.WriteLine("windows-check-job: $Message") } catch { }
    [Environment]::Exit(2)
}

$JobB64 = $env:PIASTRA_CHECK_JOB
$NodeExe = $env:PIASTRA_CHECK_JOB_NODE
if ([string]::IsNullOrWhiteSpace($JobB64)) { Fail-Closed 'missing PIASTRA_CHECK_JOB environment variable' }
if ([string]::IsNullOrWhiteSpace($NodeExe)) { Fail-Closed 'missing PIASTRA_CHECK_JOB_NODE environment variable' }

$Payload = $null
try {
    $Json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($JobB64))
    $Payload = $Json | ConvertFrom-Json
} catch {
    Fail-Closed "cannot decode PIASTRA_CHECK_JOB: $($_.Exception.Message)"
}

$Executable = [string]$Payload.executable
$WorkingDir = [string]$Payload.cwd
$TimeoutMs = [long]$Payload.timeoutMs
if ([string]::IsNullOrWhiteSpace($Executable)) { Fail-Closed 'empty executable in PIASTRA_CHECK_JOB' }
if ([string]::IsNullOrWhiteSpace($WorkingDir)) { Fail-Closed 'empty cwd in PIASTRA_CHECK_JOB' }
if ($TimeoutMs -le 0) { $TimeoutMs = 180000 }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class PiAstraJob
{
    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll")]
    public static extern bool SetInformationJobObject(IntPtr hJob, int JobObjectInformationClass, IntPtr lpJobObjectInformation, uint cbJobObjectInformationLength);

    [DllImport("kernel32.dll")]
    public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll")]
    public static extern bool SetHandleInformation(IntPtr hObject, uint dwMask, uint dwFlags);

    [DllImport("kernel32.dll")]
    public static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll")]
    public static extern bool CloseHandle(IntPtr hObject);
}
'@

$JobObjectExtendedLimitInformation = 9
$JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
$HANDLE_FLAG_INHERIT = 0x1

$Job = [PiAstraJob]::CreateJobObject([IntPtr]::Zero, $null)
if ($Job -eq [IntPtr]::Zero) { Fail-Closed 'CreateJobObject failed' }

try {
    # The job handle must not be inherited; otherwise a descendant could keep
    # the job object alive after the supervisor exits and KILL_ON_JOB_CLOSE
    # would never fire.
    if (-not [PiAstraJob]::SetHandleInformation($Job, $HANDLE_FLAG_INHERIT, 0)) {
        Fail-Closed 'SetHandleInformation failed'
    }

    $Info = New-Object -TypeName 'PiAstraJob+JOBOBJECT_EXTENDED_LIMIT_INFORMATION'
    # Nested structs are value types: mutate a standalone value then assign
    # it back, otherwise PowerShell silently changes only a boxed copy.
    $Basic = New-Object -TypeName 'PiAstraJob+JOBOBJECT_BASIC_LIMIT_INFORMATION'
    $Basic.LimitFlags = $JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    $Info.BasicLimitInformation = $Basic
    $Size = [System.Runtime.InteropServices.Marshal]::SizeOf($Info)
    $Ptr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($Size)
    try {
        [System.Runtime.InteropServices.Marshal]::StructureToPtr($Info, $Ptr, $false)
        if (-not [PiAstraJob]::SetInformationJobObject($Job, $JobObjectExtendedLimitInformation, $Ptr, $Size)) {
            Fail-Closed 'SetInformationJobObject failed'
        }
    } finally {
        [System.Runtime.InteropServices.Marshal]::FreeHGlobal($Ptr)
    }

    # Fixed Node command runner. It spawns the target from the base64 JSON env
    # and forwards stdio and the exit code. It contains no double quotes, so it
    # can be passed verbatim as a single `-e` argument.
    $Runner = @'
process.stdin.once('data',()=>{process.stdin.pause();const{spawn}=require('child_process');const p=JSON.parse(Buffer.from(process.env.PIASTRA_CHECK_JOB,'base64').toString('utf8'));const c=spawn(p.executable,p.args,{cwd:p.cwd,shell:false,stdio:'inherit',windowsHide:true});c.on('error',e=>{process.stderr.write('windows-check-job: '+e.message+'\n');process.exit(127)});c.on('close',(code,signal)=>{process.exit(signal?1:(code==null?1:code))});});
'@

    $Psi = New-Object System.Diagnostics.ProcessStartInfo
    $Psi.FileName = $NodeExe
    $Psi.Arguments = '-e "' + $Runner + '"'
    $Psi.UseShellExecute = $false
    $Psi.RedirectStandardInput = $true
    $Psi.RedirectStandardOutput = $true
    $Psi.RedirectStandardError = $true
    $Psi.WorkingDirectory = $WorkingDir
    $Psi.CreateNoWindow = $true

    $Proc = New-Object System.Diagnostics.Process
    $Proc.StartInfo = $Psi
    if (-not $Proc.Start()) { Fail-Closed 'failed to start the command runner' }
    # The trusted runner waits on stdin; no check is spawned until containment
    # is established. Keep the supervisor OUTSIDE the job so it can drain
    # output and preserve the exit code after closing/killing the job.
    if (-not [PiAstraJob]::AssignProcessToJobObject($Job, $Proc.Handle)) {
        $Proc.Kill()
        Fail-Closed 'AssignProcessToJobObject failed'
    }
    $OutTask = $Proc.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput())
    $ErrTask = $Proc.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())
    $Proc.StandardInput.WriteLine('start')
    $Proc.StandardInput.Close()
    $TimedOut = -not $Proc.WaitForExit([int]($TimeoutMs + 60000))
    $Code = if ($TimedOut) { 124 } else { $Proc.ExitCode }
    [PiAstraJob]::CloseHandle($Job) | Out-Null
    $Job = [IntPtr]::Zero
    # Orphaned pipe holders died with the job; complete the bounded external
    # capture without buffering the full output in PowerShell.
    [System.Threading.Tasks.Task]::WaitAll([System.Threading.Tasks.Task[]]@($OutTask, $ErrTask)) | Out-Null
    exit $Code
} catch {
    Fail-Closed $_.Exception.Message
} finally {
    if ($Job -ne [IntPtr]::Zero) { [PiAstraJob]::CloseHandle($Job) | Out-Null }
}
