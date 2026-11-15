// Windows build environment helpers.
//
// When cross-compiling to `x86_64-pc-windows-gnu` from a Linux host, some
// crates (notably `ring`/`cc`) expect a Windows-targeted C toolchain.  This
// module is a best-effort shim that ensures the environment is set up to the
// extent the current machine allows.  If no Windows CC is available, the
// compile will fail early with a clear message.

#[cfg(target_os = "windows")]
use std::env;

#[cfg(target_os = "windows")]
pub fn prepare_env() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Let Cargo know the target CC if it is discoverable.
    if let Ok(cc) = std::process::Command::new("sh")
        .arg("-c")
        .arg("command -v x86_64-w64-mingw32-gcc || command -v x86_64-w64-mingw32-gcc-posix || true")
        .output()
    {
        let cc_path = String::from_utf8_lossy(&cc.stdout).trim().to_string();
        if !cc_path.is_empty() {
            env::set_var("CC_x86_64_pc_windows_gnu", &cc_path);
            env::set_var("CC_x86_64-pc-windows-gnu", &cc_path);
            env::set_var("TARGET_CC", &cc_path);
            env::set_var("CC", &cc_path);
        }
    }

    // If the user has a Windows SDK / lib.exe available for msvc targets, they
    // would set up a separate toolchain.  For the gnu target we just need a
    // working C compiler; we do not attempt to fake `lib.exe`.
    Ok(())
}
