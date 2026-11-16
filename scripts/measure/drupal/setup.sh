#!/bin/sh
# installs the standard profile into the rig copy and seeds it; run once per copy of the source
set -eu

ROOT=/rig/drupal
PASS=$(head -c 18 /dev/urandom | base64)

cd "$ROOT"
mkdir -p rig-site
cp /rig/b4/site-recipe/recipe.yml rig-site/recipe.yml
php -d auto_prepend_file=/rig/b4/fiber-shim.php core/scripts/dr install "$ROOT/rig-site" \
	--site-name=spool-b4 \
	--password="$PASS" \
	--url=http://b4-srv:8080 \
	--no-interaction \
	--quiet

chmod u+w sites/default/settings.php
echo "if (getenv('SPOOL_B4_RIG') === '1') { require '/rig/b4/settings.rig.php'; }" >> sites/default/settings.php

php -d auto_prepend_file=/rig/b4/fiber-shim.php /rig/b4/setup.php
