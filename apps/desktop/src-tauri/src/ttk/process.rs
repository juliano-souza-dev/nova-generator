use std::{ffi::OsStr, process::Command};

/// Creates a child process without opening a separate console window on Windows.
/// stdout and stderr remain available to the caller for progress and diagnostics.
pub fn hidden_command(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}
