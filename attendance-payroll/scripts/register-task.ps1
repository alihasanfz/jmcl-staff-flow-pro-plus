$vbsPath = 'c:\Users\JMCL\Downloads\jmcl-staff-flow-pro-main\jmcl-staff-flow-pro-main\attendance-payroll\scripts\start-gateway-silent.vbs'
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbsPath`""
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 365)
Register-ScheduledTask -TaskName 'JMCL_ZKTeco_Gateway' -Action $action -Trigger $trigger -Settings $settings -Force
Write-Host "Scheduled Task Registered Successfully!"
