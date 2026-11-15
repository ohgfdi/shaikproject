# Environment assets

The scenes reflect image-based lighting from two equirectangular HDRI maps that
ship with the app. They are served from this directory, same-origin, so an
offline or self-hosted install never reaches the public internet for lighting.
If a map cannot be fetched, the app keeps its procedural studio environment
instead — see `lib/scene/environment.ts`.

| File                     | Used by                 | Source                                                                                                               | Licence                            |
| ------------------------ | ----------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `studio_small_08_1k.hdr` | Light theme environment | [Studio Small 08](https://polyhaven.com/a/studio_small_08) by Sergej Majboroda — [Poly Haven](https://polyhaven.com) | CC0 1.0 (public domain dedication) |
| `moonless_golf_1k.hdr`   | Dark theme environment  | [Moonless Golf](https://polyhaven.com/a/moonless_golf) by Greg Zaal — [Poly Haven](https://polyhaven.com)            | CC0 1.0 (public domain dedication) |

Both are 1K (1024 × 512) Radiance `.hdr` files, which is the resolution the
scene tier asks for; the PMREM generator downsamples them to the tier's
`envResolution`.

CC0 means no attribution is legally required. It is recorded here anyway,
because provenance is worth more than a licence waiver when you are trying to
answer "where did this light come from?" two years from now.

To replace them, drop a new `.hdr` in this directory and update the `HDRI` map in
`lib/scene/environment.ts` plus the table above. `__tests__/unit/scene-environment.test.ts`
checks that the file the switch point names actually exists on disk.
