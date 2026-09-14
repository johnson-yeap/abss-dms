module.exports = {
  env: {
    es6: true,
    node: true,
  },
  parserOptions: {
    ecmaVersion: 2022,
  },
  extends: ["eslint:recommended", "google"],
  rules: {
    "no-restricted-globals": ["error", "name", "length"],
    "prefer-arrow-callback": "error",
    "quotes": ["error", "double", {"allowTemplateLiterals": true}],

    // Google's formatting rules do not match this codebase's shape, and left on
    // they drown out the rules worth reading — unused variables, bad JSDoc.
    "indent": "off",
    "object-curly-spacing": "off",
    "comma-dangle": "off",
    "max-len": "off",
    "operator-linebreak": "off",
    "quote-props": "off",
    "padded-blocks": "off",

    "valid-jsdoc": ["error", {"requireReturn": false, "prefer": {}}],
  },
  overrides: [
    {
      files: ["**/*.test.cjs"],
      rules: {"new-cap": "off"},
    },
  ],
  globals: {},
};
