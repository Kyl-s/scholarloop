import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.join(__dirname, "..");
export const DATA_DIR = path.resolve(process.env.SCHOLARLOOP_DATA_DIR || path.join(PROJECT_ROOT, "data"));
export const TOOLS_DIR = path.resolve(process.env.SCHOLARLOOP_TOOLS_DIR || path.join(PROJECT_ROOT, "tools"));

export const dataPath = (...parts) => path.join(DATA_DIR, ...parts);
export const toolsPath = (...parts) => path.join(TOOLS_DIR, ...parts);
