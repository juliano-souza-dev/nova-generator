use std::{ffi::OsStr, process::Command};

/// Launch a native tool without opening a separate console window on Windows.
/// Output and progress remain owned by the application.
pub(crate) fn hidden_command<S: AsRef<OsStr>>(program: S) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    command
}
