#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p workspace results
if [ ! -d workspace/genoffice/.git ]; then
  git clone https://github.com/genspark-ai/genoffice.git workspace/genoffice
fi
git -C workspace/genoffice checkout --detach 36a509e8fc16ace85ed7afa3c37acb7b9c441ad1
if [ ! -f package.json ]; then
  node -e 'require("fs").writeFileSync("package.json", JSON.stringify({private:true,type:"module",dependencies:{tsx:"4.23.15",jszip:"3.10.1",zod:"4.6.7",numfmt:"3.2.6"}},null,2))'
fi
npm install --ignore-scripts --no-audit --no-fund
npm pack gridpath@0.5.2 --pack-destination workspace --ignore-scripts --silent
node --input-type=module -e 'import {readFileSync} from "node:fs";import {createHash} from "node:crypto";if(createHash("sha256").update(readFileSync("workspace/gridpath-0.5.2.tgz")).digest("hex")!=="ee6e10297791bcd29618bf2975f7683b09882270415f395b032a7062ca32dc0a")throw new Error("tarball integrity mismatch")'
mkdir -p workspace/gridpath-package
tar -xzf workspace/gridpath-0.5.2.tgz --strip-components=1 -C workspace/gridpath-package
# Link only the Apache zip-gate package needed by the upstream XLSX gateway.
mkdir -p node_modules/@genoffice
ln -sfn ../../workspace/genoffice/packages/zip-gate node_modules/@genoffice/zip-gate
ln -sfn ../../node_modules workspace/genoffice/node_modules
