import { defineConfig } from 'tsup'

export default defineConfig({
  entry: [
    'src/fetch/index.ts',
    'src/eventsource/index.ts',
    'src/types.ts',
  ],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
})
