import { resolve } from "path";
import { builtinModules } from "node:module";
import { defineConfig } from "vite";
import { viteStaticCopy } from 'vite-plugin-static-copy';

/** @type {import('vite').UserConfig} */
const config = defineConfig({
	assetsInclude: ["**/*.ttf"],
	publicDir: "./src/webview-ui/public",
	build: {
		lib: {
			entry: "./src/extension.ts",
		},
		rollupOptions: {
			external: ["vscode", ...builtinModules, ...builtinModules.map(name => `node:${name}`)],
			input: {
				extension: resolve(__dirname, "src/extension.ts"),
				index: resolve(__dirname, "src/webview-ui/index.tsx"),
				config: resolve(__dirname, "src/configview/index.tsx")
			},
			output: [
				{
					format: "cjs",
					entryFileNames: "[name].js",
				},
				{
					format: "es",
					entryFileNames: "[name].[format].js",
				},
			],
		},
		sourcemap: true,
		outDir: "out",
	},
	plugins: [
		viteStaticCopy({
			targets: [
			  {
				src: 'src/.wasm/*.wasm',
				dest: './'
			  }
			]
		})
	],
});

export default config;
