# Dependency compatibility patches

`@protontech__crypto@2.1.3.patch` only adds `@ts-nocheck` to published TypeScript
dependency files that otherwise produce diagnostics under this app's compiler
settings. The package ships source instead of declaration files and assumes
Proton's TypeScript settings (including `.ts` imports and newer typed-array types).
The app's compiler options, SDK call-site types, and dependency runtime code remain
unchanged. Reassess this patch when upgrading the pinned Proton crypto package.
