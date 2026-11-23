Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

' Ensure any previous gateway instance is cleanly stopped
Set objWMIService = GetObject("winmgmts:\\.\root\cimv2")
Set colItems = objWMIService.ExecQuery("Select * from Win32_Process Where CommandLine Like '%zkteco-gateway.js%'")
For Each objItem in colItems
  objItem.Terminate()
Next

WScript.Sleep 500

nodeExe = "C:\Program Files\nodejs\node.exe"
logFile = scriptDir & "\gateway.log"
gatewayScript = scriptDir & "\zkteco-gateway.js"

cmd = "cmd.exe /c """"" & nodeExe & """ """ & gatewayScript & """ --server-url https://attendance-payroll-ten.vercel.app --proxy-port 8080 >> """ & logFile & """ 2>&1"""

WshShell.CurrentDirectory = scriptDir
WshShell.Run cmd, 0, False
