$scriptPath = 'c:\Users\JMCL\Downloads\jmcl-staff-flow-pro-main\jmcl-staff-flow-pro-main\attendance-payroll\scripts\zkteco-gateway.js'
$workDir = 'c:\Users\JMCL\Downloads\jmcl-staff-flow-pro-main\jmcl-staff-flow-pro-main\attendance-payroll\scripts'
$nodeExe = 'C:\Program Files\nodejs\node.exe'

# Kill any existing gateway instance
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*zkteco-gateway.js*' } | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Seconds 1

$arguments = @(
    $scriptPath,
    '--server-url', 'https://attendance-payroll-ten.vercel.app',
    '--proxy-port', '8080'
)

$process = Start-Process -FilePath $nodeExe -ArgumentList $arguments -WorkingDirectory $workDir -WindowStyle Hidden -PassThru
Write-Host "Started Gateway with PID:" $process.Id
