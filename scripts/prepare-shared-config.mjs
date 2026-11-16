// Shared Runtime Manager now owns the generated configuration.
// Keep this command as a migration-friendly entry point, but never create a
// shared.config.json inside the application source tree.
console.log("A configuração do Shared Runtime é gerenciada centralmente.");
console.log("Abra o Shared Runtime Manager e registre/sincronize o Nova Generator.");
console.log("O arquivo será salvo em %LOCALAPPDATA%\\JulianoDev\\SharedRuntime\\applications\\nova-generator\\shared.config.json.");
