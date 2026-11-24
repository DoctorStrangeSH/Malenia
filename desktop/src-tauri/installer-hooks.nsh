; Refuse replacement/removal of running frozen resources. Opening in append
; mode tests write access without changing bytes; FileExists avoids creation.
!macro MALENIA_CHECK_RESOURCE relative
  ${If} ${FileExists} "$INSTDIR\${relative}"
    ClearErrors
    FileOpen $R8 "$INSTDIR\${relative}" a
    ${If} ${Errors}
      IfSilent +2
      MessageBox MB_OK|MB_ICONSTOP "Close Malenia and its browser bridge, then retry setup. A resource is still in use."
      SetErrorLevel 32
      Quit
    ${EndIf}
    FileClose $R8
  ${EndIf}
!macroend

!macro MALENIA_CHECK_RESOURCES
  Push $R8
  !insertmacro MALENIA_CHECK_RESOURCE "resources\malenia-agent\malenia-agent.exe"
  !insertmacro MALENIA_CHECK_RESOURCE "resources\malenia-native-host\malenia-native-host.exe"
  Pop $R8
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro MALENIA_CHECK_RESOURCES
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro MALENIA_CHECK_RESOURCES
!macroend

; Windows caches icons of shortcuts and executables. After an update with a new
; icon, ask the shell to refresh so the desktop/Start shortcuts show it at once.
!macro NSIS_HOOK_POSTINSTALL
  Push $R9
  ${If} ${FileExists} "$SYSDIR\ie4uinit.exe"
    nsExec::Exec '"$SYSDIR\ie4uinit.exe" -show'
    Pop $R9
  ${EndIf}
  Pop $R9
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
