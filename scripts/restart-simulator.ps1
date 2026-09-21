param(
    [ValidateSet('Local', 'Linux')][string]$Target,
    [string]$LinuxOrigin = 'wss://calendar.eveng2assistant.com',
    [string]$NodePath,
    [switch]$CheckOnly,
    [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$clientRoot = Join-Path $projectRoot 'clients\even'
$backendEntry = Join-Path $projectRoot 'src\conversation-server.ts'
$viteEntry = Join-Path $clientRoot 'node_modules\vite\bin\vite.js'
$simulatorExe = Join-Path $projectRoot 'tools\even-simulator\node_modules\@evenrealities\sim-win32-x64\bin\evenhub-simulator.exe'
if (!$Target) {
    $selection = Read-Host 'Restart simulator: 1 = LOCAL backend, 2 = LINUX backend'
    $Target = switch ($selection) { '1' { 'Local' } '2' { 'Linux' } default { throw 'Choose 1 or 2.' } }
}
$backendOrigin = 'ws://127.0.0.1:3001'
if ($Target -eq 'Linux') {
    $remote = [Uri]$LinuxOrigin
    if (!$remote.IsAbsoluteUri -or $remote.Scheme -ne 'wss' -or $remote.UserInfo -or $remote.AbsolutePath -ne '/' -or $remote.Query -or $remote.Fragment) {
        throw 'LinuxOrigin must be a bare wss:// origin, without credentials, path or query.'
    }
    $backendOrigin = $LinuxOrigin
}
if (!$NodePath) {
    $bundledNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
    $NodePath = if (Test-Path -LiteralPath $bundledNode) { $bundledNode } else { (Get-Command node -ErrorAction Stop).Source }
}
foreach ($required in @($NodePath, $backendEntry, $viteEntry, $simulatorExe)) {
    if (!(Test-Path -LiteralPath $required -PathType Leaf)) { throw "Missing dependency: $required. Install project, clients/even and tools/even-simulator dependencies first." }
}
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
$nodeVersion = & $NodePath -p 'process.versions.node'
if ($LASTEXITCODE -ne 0 -or [int]($nodeVersion.Split('.')[0]) -lt 24) { throw 'Node.js 24 or later is required.' }
Write-Host "Target: $Target | $backendOrigin | frontend http://127.0.0.1:5173"
Write-Host 'Restart closes the simulator and interrupts local in-flight work. No credentials are printed or copied.'
if ($CheckOnly) { Write-Host 'Preflight passed; no processes changed.'; exit 0 }

# Only stop processes with this workspace's absolute entry point; never kill by port or process name alone.
$ownedEntries = @($viteEntry, $simulatorExe)
if ($Target -eq 'Local') { $ownedEntries += $backendEntry }
Get-CimInstance Win32_Process | ForEach-Object {
    $candidate = $_
    foreach ($entry in $ownedEntries) {
        if ($candidate.CommandLine -and $candidate.CommandLine.Contains(('"' + $entry + '"'))) {
            $live = Get-Process -Id $candidate.ProcessId -ErrorAction SilentlyContinue
            if ($live -and [Math]::Abs(($live.StartTime - $candidate.CreationDate).TotalSeconds) -lt 1) {
                Stop-Process -InputObject $live
                $live.WaitForExit(10000) | Out-Null
            }
            break
        }
    }
}
$ports = @(5173, 9898)
if ($Target -eq 'Local') { $ports += 3001 }
foreach ($port in $ports) {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $port)
    try { $listener.Start() } catch { throw "Port $port is occupied by an unmanaged process. Close the old launcher manually; this script will not kill an unrelated process." } finally { $listener.Stop() }
}
$logDirectory = Join-Path $projectRoot '.local\simulator-launcher'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$runId = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$started = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()
function Start-Helper($name, $file, $arguments, $directory, $visible = $false) {
    $windowStyle = if ($visible) { 'Normal' } else { 'Hidden' }
    $process = Start-Process -FilePath $file -ArgumentList $arguments -WorkingDirectory $directory -WindowStyle $windowStyle -PassThru `
        -RedirectStandardOutput (Join-Path $logDirectory "$runId-$name.out.log") `
        -RedirectStandardError (Join-Path $logDirectory "$runId-$name.err.log")
    $started.Add($process)
    return $process
}
function Wait-Http($url, $process) {
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline) {
        if ($process.HasExited) { throw 'A helper exited during startup. Inspect local launcher logs.' }
        try { $response = Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 2; if ($response.StatusCode -eq 200) { return $response.Content } } catch { }
        Start-Sleep -Milliseconds 300
    }
    throw "Startup timeout: $url"
}
try {
    if ($Target -eq 'Local') {
        $env:CONVERSATION_HOST = '127.0.0.1'
        $env:CONVERSATION_PORT = '3001'
        $backendProcess = Start-Helper 'backend' $NodePath "--use-system-ca --import tsx `"$backendEntry`"" $projectRoot
        $null = Wait-Http 'http://127.0.0.1:3001/healthz' $backendProcess
    }
    $env:EVEN_DEV_BACKEND_ORIGIN = $backendOrigin
    $viteProcess = Start-Helper 'vite' $NodePath "--use-system-ca `"$viteEntry`"" $clientRoot
    $viteEnvironment = Wait-Http 'http://127.0.0.1:5173/@vite/env' $viteProcess
    $expectedHost = ([Uri]$backendOrigin).Host
    if (!$viteEnvironment.Contains($expectedHost)) { throw 'Frontend backend label verification failed.' }
    $simulatorProcess = Start-Helper 'simulator' $simulatorExe 'http://127.0.0.1:5173 --automation-port 9898' $projectRoot $true
    Start-Sleep -Seconds 2
    if ($simulatorProcess.HasExited) { throw 'Simulator exited during startup.' }
    if (!$NoBrowser) { Start-Process 'http://127.0.0.1:5173' }
    Write-Host "Ready: $Target | $backendOrigin. Check the browser connection label before connecting."
    Write-Host "Logs: $logDirectory (local/private; do not publish)."
} catch {
    foreach ($process in $started) { if (!$process.HasExited) { Stop-Process -InputObject $process -ErrorAction SilentlyContinue } }
    throw
}
