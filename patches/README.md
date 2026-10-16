# Patches to installed dependencies

`npm install` / `npm ci` run `patch-package` from `postinstall`, which applies every `*.patch` here to
`node_modules`. It runs with `--error-on-fail --error-on-warn`, so the install fails if a patch no
longer applies, or was made for a different version than the one installed. It never skips a patch
quietly. `src/engine/adapters/whatsapp-web-js.patches.spec.ts` checks that the installed files carry them.

## whatsapp-web.js+1.34.7.patch

1.34.7 is the latest release on npm (checked 2026-10-16). Against the current WhatsApp Web it cannot
send media and loses the id of everything it sends. The patch is two upstream commits that no release
contains yet:

- **wwebjs/whatsapp-web.js#201923** (`064a3d5`, 2026-09-28): deletes `__x_id` from the outgoing message
  in `src/util/Injected/Utils.js`. Without it every image, video, audio or document send fails with
  `Data passed to getter must include an id property (it's how we memoize) but got undefined`.
- **wwebjs/whatsapp-web.js#201832** (`58ddf15`, 2026-09-26): WhatsApp Web renamed a message key's
  serialized id from `_serialized` to `$1`. On 2026-10-16 the `WAWebMsgKey` constructor served by
  web.whatsapp.com set `this.$1 = [fromMe, remote, id, …].join("_")` and had no `_serialized`. Without the
  fallback, `sendMessage` looks itself up with `Msg.get(undefined)` and returns nothing. OpenWA then
  answers every send without a message id, and received messages and acks carry no id. The commit's
  `Contact.unblock()` hunk is left out: it depends on a refactor (`f7e4d3d`) that is not in 1.34.7.
  Its `index.d.ts` change is formatting only and is also left out.

**Drop this patch** when a whatsapp-web.js release contains both #201923 and #201832. Upgrade the
dependency, delete the patch file, and delete the expectations for it in
`whatsapp-web-js.patches.spec.ts`. Until then a version bump fails `npm ci` on purpose. Regenerate the
patch against the new version (`npx patch-package whatsapp-web.js`) or drop it.
