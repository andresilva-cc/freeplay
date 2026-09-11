import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

function loadStaticFilesFromDisk() {
    const currentFilePath = fileURLToPath(import.meta.url);
    const staticRoot = path.resolve(path.dirname(currentFilePath), "..", "static");

    return listStaticFiles(staticRoot).reduce(function (allFiles, filePath) {
        const relativePath = path.relative(staticRoot, filePath).split(path.sep).join("/");
        const routePath = "/static/" + relativePath;

        allFiles[routePath] = {
            body: fs.readFileSync(filePath, "utf8"),
            contentType: getContentType(relativePath)
        };
        return allFiles;
    }, {});
}

export const embeddedStaticFiles = loadStaticFilesFromDisk();
