import resolve from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import typescript from "@rollup/plugin-typescript";
import fs from "node:fs";
import path from "node:path";

const embeddedStaticSourcePath = path.resolve("src", "embeddedStaticAssets.js");

function getContentType(fileName) {
    if (fileName.endsWith(".html")) {
        return "text/html; charset=utf-8";
    }
    if (fileName.endsWith(".css")) {
        return "text/css; charset=utf-8";
    }
    if (fileName.endsWith(".js")) {
        return "text/javascript; charset=utf-8";
    }
    if (fileName.endsWith(".json")) {
        return "application/json; charset=utf-8";
    }

    return "text/plain; charset=utf-8";
}

function listStaticFiles(rootPath) {
    if (!fs.existsSync(rootPath)) {
        return [];
    }

    return fs.readdirSync(rootPath, { withFileTypes: true }).reduce(function (files, entry) {
        const entryPath = path.join(rootPath, entry.name);

        if (entry.isDirectory()) {
            return files.concat(listStaticFiles(entryPath));
        }

        return files.concat(entryPath);
    }, []);
}

function embeddedStaticAssets() {
    const staticRoot = path.resolve("static");

    return {
        name: "embedded-static-assets",
        buildStart() {
            listStaticFiles(staticRoot).forEach((filePath) => {
                this.addWatchFile(filePath);
            });
        },
        load(id) {
            if (path.resolve(id) !== embeddedStaticSourcePath) {
                return null;
            }

            const embeddedFiles = listStaticFiles(staticRoot).reduce(function (allFiles, filePath) {
                const relativePath = path.relative(staticRoot, filePath).split(path.sep).join("/");
                const routePath = "/static/" + relativePath;

                allFiles[routePath] = {
                    body: fs.readFileSync(filePath, "utf8"),
                    contentType: getContentType(relativePath)
                };
                return allFiles;
            }, {});

            return "export const embeddedStaticFiles = " + JSON.stringify(embeddedFiles) + ";";
        },
    };
}

/**
 * @type {import("rollup").RollupOptions}
 */
const config = {
    input: "./src/index.ts",
    output: [
        {
            file: "out/mcp.js",
            format: "iife",
        },
        {
            file: "out/mcp.min.js",
            format: "iife",
            plugins: [
                terser()
            ]
        }
    ],
    plugins: [
        embeddedStaticAssets(),
        resolve(),
        typescript()
    ],
    treeshake: "smallest"
};
export default config;
