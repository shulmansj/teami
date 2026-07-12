import js from "@eslint/js";
import importPlugin from "eslint-plugin-import";
import globals from "globals";

export const STATIC_QUALITY_CONFIG = [
  {
    ignores: [
      "node_modules/**",
      "openwiki/**",
      // Historical spikes and one-off live proof scripts are retained as
      // private evidence, not maintained executable product surfaces.
      "private/execution/**",
      "private/maintainers/scripts/**",
      // Candidate-tree fixtures intentionally contain copied or damaged source.
      // Their owning *.test.mjs harnesses remain linted.
      "test/fixtures/staged-build/clean/**",
      "test/fixtures/staged-build/guard-coverage-removal/**",
    ],
  },
  {
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
    plugins: {
      import: importPlugin,
    },
    settings: {
      // eslint-plugin-import 2.x does not resolve this package's ESM export map,
      // although Node does. Keep the exact used subpaths explicit so local file
      // resolution remains enforced everywhere else.
      "import/core-modules": [
        "@modelcontextprotocol/sdk/client/index.js",
        "@modelcontextprotocol/sdk/client/stdio.js",
        "@modelcontextprotocol/sdk/server/mcp.js",
        "@modelcontextprotocol/sdk/server/stdio.js",
        "@modelcontextprotocol/sdk/shared/stdio.js",
      ],
      "import/resolver": {
        node: {
          extensions: [".js", ".mjs", ".json"],
        },
      },
    },
    rules: {
      "no-undef": js.configs.recommended.rules["no-undef"],
      "no-global-assign": "error",
      "no-unused-vars": [
        "error",
        {
          args: "none",
          caughtErrors: "none",
          ignoreRestSiblings: true,
          vars: "all",
        },
      ],
      "import/no-unresolved": ["error", { caseSensitive: true }],
      "import/named": "error",
      "import/default": "error",
      "import/namespace": "error",
      "import/export": "error",
      "import/no-duplicates": "error",
    },
  },
];

export default STATIC_QUALITY_CONFIG;
