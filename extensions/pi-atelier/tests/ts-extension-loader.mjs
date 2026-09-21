import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, nextResolve) {
	if (context.parentURL && specifier.startsWith(".") && specifier.endsWith(".js")) {
		const tsUrl = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
		if (existsSync(fileURLToPath(tsUrl))) return { shortCircuit: true, url: tsUrl.href };
	}
	return nextResolve(specifier, context);
}
