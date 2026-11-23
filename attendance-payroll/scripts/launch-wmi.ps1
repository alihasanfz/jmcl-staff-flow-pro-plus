$cmd = 'cmd.exe /c ""C:\Program Files\nodejs\node.exe" "c:\Users\JMCL\Downloads\jmcl-staff-flow-pro-main\jmcl-staff-flow-pro-main\attendance-payroll\scripts\zkteco-gateway.js" --server-url https://attendance-payroll-ten.vercel.app --proxy-port 8080 >> "c:\Users\JMCL\Downloads\jmcl-staff-flow-pro-main\jmcl-staff-flow-pro-main\attendance-payroll\scripts\gateway.log" 2>&1"'
$workDir = 'c:\Users\JMCL\Downloads\jmcl-staff-flow-pro-main\jmcl-staff-flow-pro-main\attendance-payroll\scripts'

# Kill any existing gateway
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*zkteco-gateway.js*' } | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Milliseconds 500

$proc = [wmiclass]"Win32_Process"
$result = $proc.Create($cmd, $workDir, $null)
Write-Host "WMI ReturnValue:" $result.ReturnValue "ProcessId:" $result.ProcessId
