import { cwd } from "process";
import { resolve, extname } from "path";
import type { ResolvedConfig } from "vite";
import type { OutputBundle, OutputChunk, OutputAsset, NormalizedOutputOptions } from "rollup";
import { normalizePath } from "./utils";
import path from 'node:path'

const getDevEntryPoints = (config: ResolvedConfig, viteDevServerUrl: string) => {
  const entryPoints: EntryPoints = {};

  for (const [entryName, { entryPath, entryType }] of Object.entries(parseInput(config))) {
    entryPoints[entryName] = {
      [entryType]: [`${viteDevServerUrl}${config.base}${entryPath}`],
    };
  }
  return entryPoints;
};

const getBuildEntryPointsLegacy = (config: ResolvedConfig, manifest: Manifest) => {
  const entryPoints: EntryPoints = {};

  for (const [entryName, entry] of Object.entries(parseInput(config))) {
    entryPoints[entryName] = parseManifestEntry(entry, manifest, config);
  }

  return entryPoints;
};


const addBuildEntryPoints = (
  options: NormalizedOutputOptions,
  config: ResolvedConfig,
  bundle: OutputBundle,
  entryPoints: EntryPoints
) => {

  function getLegacyName(name: string) {
    const ext = path.extname(name)
    const endPos = ext.length !== 0 ? -ext.length : undefined
    name = name.slice(0, endPos) + `-legacy` + ext
    return name
  }

  function getFileName(chunk: OutputAsset | OutputChunk) {
    if (chunk.type === 'asset') {
      return chunk.name;
    } else if (chunk.type === 'chunk') {
      if (chunk.facadeModuleId) {
        let name = normalizePath(
          path.relative(config.root, chunk.facadeModuleId)
        )
        if (options.format === 'system' && !chunk.name.includes('-legacy')) {
          name = getLegacyName(name)
        }
        return name.replace(/\0/g, '')
      } else {
        return chunk.fileName;
      }
    }
  }

  let name2exportName: StringMapping = {};
  for (let chunkName in bundle) {
    name2exportName[getFileName(bundle[chunkName])] = chunkName;
  }

  let entryFiles = parseInput(config);
  for (const [entryName, entry] of Object.entries(entryFiles)) {
    let exportPath = name2exportName[entry.entryPath];
    let fileInfos = <OutputChunk & {viteMetadata: ChunkMetadata}>bundle[exportPath];
    let isLegacy = false;
    if (!fileInfos) {
        let legacyEntryPath = getLegacyName(entry.entryPath);
        exportPath = name2exportName[legacyEntryPath];
        fileInfos = <OutputChunk & {viteMetadata: ChunkMetadata}>bundle[exportPath];
        if (!fileInfos) {
            throw new Error(`Unable to find ${exportPath}`);
        }
        isLegacy = true;
    }

    let finalEntryName = isLegacy ? `${entryName}-legacy` : entryName
    let legacyEntryPoint = typeof entryPoints[`${finalEntryName}-legacy`] !== "undefined" ? `${finalEntryName}-legacy` : false

    entryPoints[finalEntryName] = resolveEntrypoint(fileInfos, bundle, config, legacyEntryPoint, true);
    
  }

  if (name2exportName['vite/legacy-polyfills-legacy']) {
    let fileInfos = <OutputChunk & {viteMetadata: ChunkMetadata}>bundle[
      name2exportName['vite/legacy-polyfills-legacy']
    ];
    entryPoints['polyfills-legacy'] = resolveEntrypoint(fileInfos, bundle, config, false, true);
  }

  return entryPoints;
};

const resolveEntrypoint = (
  fileInfos: OutputChunk & {viteMetadata: ChunkMetadata},
  bundle: OutputBundle,
  config: ResolvedConfig,
  legacyEntryPoint: Boolean | String,
  isCSSOrJsEntry: Boolean
) => {

  const js: string[] = [];
  const css: string[] = [];
  const preload: string[] = [];

  if (fileInfos.imports) {
    for (const importEntryName of fileInfos.imports) {
      let importFileInfos = <OutputChunk & {viteMetadata: ChunkMetadata}>bundle[importEntryName];
      if (!importFileInfos) {
        throw new Error(`Unable to find ${importEntryName}`);
      }
      const {css: importCss, preload: importPreload } = resolveEntrypoint(
        importFileInfos,
        bundle,
        config,
        false,
        false
      );

      for (const dependency of importCss) {
        if (css.indexOf(dependency) === -1) {
          css.push(dependency);
        }
      }
      for (const dependency of importPreload) {
        if (preload.indexOf(dependency) === -1) {
          preload.push(dependency);
        }
      }
    }
  }

  let filePath = `${config.base}${fileInfos.fileName}`

  debugger
  if (isCSSOrJsEntry) {
      if (fileInfos.isEntry) {
          js.push(filePath)
      } else {
          css.push(filePath)
      }
  } else if (preload.indexOf(filePath) === -1) {
      preload.push(filePath);
  }

  if (fileInfos.viteMetadata?.importedCss.size) {
    fileInfos.viteMetadata.importedCss.forEach(cssFilePath => {
        css.push(cssFilePath);
    })
  }
  return { js, css, preload, legacy: legacyEntryPoint };
}


const parseManifestEntry = ({ entryPath, entryType }: ParsedEntry, manifest: Manifest, config: ResolvedConfig) => {
  if (!manifest[entryPath]) {
    throw new Error(`Entrypoint ${entryPath} not defined in the manifest`);
  }
  const manifestEntry = manifest[entryPath];

  const js: string[] = [];
  const css: string[] = [];
  const preload: string[] = [];

  if (manifestEntry.imports) {
    for (const importEntryName of manifestEntry.imports) {
      const { css: importCss, preload: importPreload } = parseManifestEntry(
        {
          entryPath: importEntryName,
          entryType: "js",
        },
        manifest,
        config,
      );

      for (const dependency of importCss) {
        if (css.indexOf(dependency) === -1) {
          css.push(dependency);
        }
      }
      for (const dependency of importPreload) {
        if (preload.indexOf(dependency) === -1) {
          preload.push(dependency);
        }
      }
    }
  }

  if (manifestEntry.isEntry) {
    if (entryType === "js") {
      js.push(`${config.base}${manifestEntry.file}`);
    } else if (entryType === "css") {
      css.push(`${config.base}${manifestEntry.file}`);
    }
  } else if (preload.indexOf(`${config.base}${manifestEntry.file}`) === -1) {
    preload.push(`${config.base}${manifestEntry.file}`);
  }

  if (manifestEntry.css) {
    manifestEntry.css.forEach((cssEntry) => {
      if (css.indexOf(`${config.base}${cssEntry}`) === -1) {
        css.push(`${config.base}${cssEntry}`);
      }
    });
  }

  return { js, css, preload };
};

const parseInput = (config: ResolvedConfig) => {
  const inputParsed: ParsedInput = {};
  // let isLegacy = (options.format === 'system' && bundle[chunkName].name.includes('-legacy'));

  for (const [entryName, entryPath] of Object.entries(config.build.rollupOptions.input)) {
    const entryAbsolutePath = normalizePath(resolve(cwd(), entryPath));

    if (entryAbsolutePath.indexOf(config.root) !== 0) {
      console.error("Entry points must be inside Vite root directory");
      process.exit(1);
    }

    const extension = extname(entryPath);

    const entryType =
      [".css", ".scss", ".sass", ".less", ".styl", ".stylus", ".postcss"].indexOf(extension) !== -1 ? "css" : "js";

    const entryRelativePath = entryAbsolutePath.substring(config.root.length + 1);

    inputParsed[entryName] = {
      entryType,
      entryPath: entryRelativePath,
    };
  }

  return inputParsed;
};

export const getEntryFilesMapping = (config: ResolvedConfig) => {
  const inputParsed: EntryFilesMapping = {};
  // let isLegacy = (options.format === 'system' && bundle[chunkName].name.includes('-legacy'));

  for (const [entryName, entryPath] of Object.entries(config.build.rollupOptions.input)) {
    const entryAbsolutePath = normalizePath(resolve(cwd(), entryPath));

    if (entryAbsolutePath.indexOf(config.root) !== 0) {
      console.error("Entry points must be inside Vite root directory");
      process.exit(1);
    }


    const entryRelativePath = entryAbsolutePath.substring(config.root.length + 1);

    inputParsed[entryName] = entryRelativePath;
  }

  return inputParsed;
};

export { getDevEntryPoints, addBuildEntryPoints, getBuildEntryPointsLegacy };
