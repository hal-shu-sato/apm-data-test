// > yarn run check-update

import { path7za } from '7zip-bin';
import { Octokit } from '@octokit/rest';
import chalk from 'chalk';
import { execSync } from 'child_process';
import { XMLBuilder, XMLParser, XMLValidator } from 'fast-xml-parser';
import fs from 'fs-extra';
import https from 'https';
import Seven from 'node-7z';
import { basename, dirname, extname, resolve } from 'path';
import { format as _format } from 'prettier';
import { fromStream } from 'ssri';
const {
  createReadStream,
  createWriteStream,
  ensureDir,
  readFile,
  readJsonSync,
  remove,
  writeFile,
} = fs;
const { whiteBright, green, yellow, cyanBright, red } = chalk;
const { extractFull } = Seven;

// Options
const exclude = ['oov/PSDToolKit']; // IDs that won't be checked
const packagesXmlPath = 'v2/data/packages.xml';
const modXmlPath = 'v2/data/mod.xml';

function format(string) {
  const xml = string
    .trim()
    .replace(/<\?xml-model +/, '<?xml-model ') // Fix `<?xml-model   `
    .replaceAll('&quot;', '"') // Convert `&quot` to `"`
    .replaceAll(/<(.+?)>\r?\n?\t+([^<>\t]+?)\r?\n?\t+<\/(.+?)>/g, '<$1>$2</$3>') // Adjust line-breaking
    .replaceAll(/-->\r?\n?\t?<package>/g, '-->\r\n\r\n\t<package>') // Add line break between a comment and `<package>`
    .replaceAll(/<\/package>\r?\n?\t?</g, '</package>\r\n\r\n\t<') // Add line break between `<package>`
    .replaceAll(/\r?\n?\t?<\/packages>/g, '</packages>'); // Remove line break before `</package>`
  return _format(xml, { parser: 'xml', useTabs: true });
}

async function unzip(zipPath, folderName = null) {
  const outputPath = resolve(
    'util/temp',
    folderName ?? basename(zipPath, extname(zipPath))
  );

  const zipStream = extractFull(zipPath, outputPath, {
    $bin: path7za,
    overwrite: 'a',
  });
  return new Promise((resolve) => {
    zipStream.once('end', () => {
      resolve(outputPath);
    });
  });
}

async function generateHash(path) {
  const readStream = createReadStream(path);
  const str = await fromStream(readStream, {
    algorithms: ['sha384'],
  });
  readStream.destroy();
  return str.toString();
}

const parser = new XMLParser({
  attributeNamePrefix: '$',
  commentPropName: '#comment',
  ignoreAttributes: false,
  parseAttributeValue: false,
  parseTagValue: false,
  preserveOrder: true,
  textNodeName: '_',
  trimValues: true,
});

const builder = new XMLBuilder({
  attributeNamePrefix: '$',
  commentPropName: '#comment',
  format: true,
  ignoreAttributes: false,
  indentBy: '\t',
  preserveOrder: true,
  suppressEmptyNode: true,
  textNodeName: '_',
});

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const archiveNamePattern = readJsonSync('util/archive-name-pattern.json');

async function checkPackageUpdate(p) {
  const result = {
    updateAvailable: false,
    message: '',
  };

  const packageItem = p.package;

  const getValue = (key) => {
    return packageItem.find((value) => key in value)[key][0]._;
  };

  const id = getValue('id');
  const downloadURL = new URL(getValue('downloadURL'));
  const currentVersion = getValue('latestVersion');

  const dirs = downloadURL.pathname.split('/');
  dirs.shift();

  if (
    exclude.includes(id) ||
    downloadURL.hostname !== 'github.com' ||
    dirs[2] !== 'releases' ||
    currentVersion === '最新'
  )
    return result;

  try {
    const res = await octokit.rest.repos.getLatestRelease({
      owner: dirs[0],
      repo: dirs[1],
    });

    let latestTag = res.data.tag_name;

    // only for hebiiro's packages
    if (dirs[0] === 'hebiiro') {
      const versionArray = latestTag
        .split('.')
        .filter((value) => /[0-9]+/.test(value));
      if (versionArray.length >= 1) {
        latestTag = versionArray.join('.');
      } else {
        throw new Error('A version-like string is not found.');
      }
    }

    if (latestTag === currentVersion) {
      result.message = whiteBright(id) + ' ' + green(currentVersion);
      return result;
    }

    const currentVersionIndex = packageItem.findIndex(
      (value) => 'latestVersion' in value
    );
    packageItem[currentVersionIndex].latestVersion[0]._ = latestTag;

    // Create integrity
    if (Object.keys(archiveNamePattern).includes(id)) {
      const matchPattern = new RegExp('^' + archiveNamePattern[id] + '\\.zip$');
      const assets = res.data.assets;
      const archiveData = assets.find((value) => matchPattern.test(value.name));
      if (archiveData && extname(archiveData.name) === '.zip') {
        const url = archiveData.browser_download_url;

        const archivePath = resolve('util/temp/archive', archiveData.name);
        await ensureDir(dirname(archivePath));
        const outArchive = createWriteStream(archivePath, 'binary');

        const download = (url, destination) =>
          new Promise((resolve, reject) => {
            https.get(url, async (res) => {
              if (res.statusCode === 200) {
                res
                  .pipe(destination)
                  .on('close', () => {
                    destination.close(resolve);
                  })
                  .on('error', reject);
              } else if (res.statusCode === 302) {
                await download(res.headers.location, destination);
                resolve();
              }
            });
          });

        await download(url, outArchive);

        const unzippedPath = await unzip(archivePath);
        const targetFileObj = packageItem.find((value) => 'files' in value)
          .files[0];
        const targetFile = targetFileObj.file[0]._;
        const targetFileArchivePath = targetFileObj?.[':@']?.$archivePath ?? '';
        const targetPath = resolve(
          unzippedPath,
          targetFileArchivePath,
          basename(targetFile)
        );
        const fileHash = await generateHash(targetPath);
        const archiveHash = await generateHash(archivePath);
        packageItem
          .find((value) => 'releases' in value)
          .releases.push({
            release: [
              {
                archiveIntegrity: [{ _: archiveHash }],
              },
              {
                integrities: [
                  {
                    integrity: [{ _: fileHash }],
                    ':@': { $target: targetFile },
                  },
                ],
              },
            ],
            ':@': { $version: latestTag },
          });

        await Promise.all([remove(archivePath), remove(unzippedPath)]);
      }
    }

    result.updateAvailable = true;
    result.message =
      whiteBright(id) +
      ' ' +
      yellow(currentVersion) +
      ' ' +
      cyanBright(latestTag);
  } catch (e) {
    if (e.status === 404) {
      result.message =
        whiteBright(id) + ' ' + currentVersion + ' ' + red('Not Found');
    } else {
      result.message = red(e.message);
    }
  }

  return result;
}

async function check() {
  const packagesXmlData = await readFile(packagesXmlPath, 'utf-8');
  if (XMLValidator.validate(packagesXmlData)) {
    const packagesObj = parser.parse(packagesXmlData);

    const promisesInWaiting = [];
    for (const p of packagesObj[2].packages) {
      if ('package' in p) {
        promisesInWaiting.push(checkPackageUpdate(p));
      }
    }

    const result = await Promise.all(promisesInWaiting);
    result
      .filter((updateResult) => updateResult.message !== '')
      .forEach((updateResult) => console.log(updateResult.message));

    const updateAvailableNum = result.filter(
      (updateResult) => updateResult.updateAvailable
    ).length;

    if (updateAvailableNum >= 1) {
      const newPackagesXml = builder.build(packagesObj);
      await writeFile(packagesXmlPath, format(newPackagesXml), 'utf-8');

      console.log(green('Updated packages.xml'));
      try {
        remove('util/temp');
      } catch (e) {
        console.error(e);
      }
    }

    try {
      // Throws an error if changes in the file
      execSync('git diff --exit-code -- ' + packagesXmlPath);
      console.log('No updates available.');
    } catch {
      const modXmlData = await readFile(modXmlPath, 'utf-8');
      if (XMLValidator.validate(modXmlData)) {
        const modObj = parser.parse(modXmlData);

        const padNumber = (number) => number.toString().padStart(2, '0');
        const toISODate = (date) =>
          date.getFullYear() +
          '-' +
          padNumber(date.getMonth() + 1) +
          '-' +
          padNumber(date.getDate()) +
          'T' +
          padNumber(date.getHours()) +
          ':' +
          padNumber(date.getMinutes()) +
          ':00+09:00';

        const now = new Date();
        const newModDate = toISODate(now);
        modObj[2].mod[1].packages[0]._ = newModDate;

        const newModXml = builder.build(modObj);
        await writeFile(modXmlPath, format(newModXml), 'utf-8');

        console.log(green('Updated mod.xml'));
      }
    }
  }

  console.log('Check complete.');
}

check();
