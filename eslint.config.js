import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["**/dist/", "**/coverage/"] },
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
