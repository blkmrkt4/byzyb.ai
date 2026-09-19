# byzyb.ai + pklabs.ca

Two static sites in one repo.

| | |
|---|---|
| **`byzyb/`** | byzyb.ai — Robin Hutchinson. Resume, essays, and the complete portfolio. |
| **`pklabs/`** | pklabs.ca — PainKiller Labs. Shipped products, support, and the legal layer. |
| **`shared/`** | The source of truth. Product copy, the stylesheet, and the build. |
| **`brand/`** | Logo masters. Not served by either site. |
| **`docs/manual.html`** | **Which site does this belong on?** Open this first. |

## Editing

Product copy lives in `shared/products.json`, never in a site's HTML — the
product grids are generated and a build will overwrite hand edits.

```sh
node shared/build.mjs
```

That regenerates the byzyb product grid, the pklabs product grid and one page
per shipped product, and copies `shared/ploy-styles.css` into both sites.
It exits non-zero if a page uses a CSS class neither stylesheet defines.

A product appears on pklabs.ca if, and only if, its record has a `pklabs`
block. Launching something means adding that block and setting `"status":
"Live"` — no page moves and no URL changes. See `docs/manual.html`.

## Deploying

Both sites are static; nothing builds on the server.

| Site | Host | Root Directory |
|---|---|---|
| byzyb.ai | Vercel | `byzyb` |
| pklabs.ca | Vercel | `pklabs` |

**The byzyb.ai Vercel project's Root Directory must be set to `byzyb`** — its
files used to sit at the repo root. Until that setting changes, a deploy
serves an empty site.
