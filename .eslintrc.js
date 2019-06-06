module.exports = {
    //parser: 'babel-eslint',
    env: {
      es6: true,
      node: true,
      mocha: true
    },
    plugins: ['prettier', 'security'],
    extends: ['airbnb', 'prettier', 'plugin:security/recommended'],
    globals: {
      expect: true,
      contract: true,
      web3: true,
      artifacts: true,
    },
    parserOptions: {
      ecmaVersion: 2018,
      sourceType: 'module'
    },
    rules: {
      'prettier/prettier': 'error',
      'no-console': ['error', { allow: ['warn', 'error', 'info'] }],
      'import/no-extraneous-dependencies': [
        'error',
        { devDependencies: ['test/*.test.js', 'mocha.setup.js'] }
      ]
    },
    overrides: [
      {
        files: '*.test.js',
        rules: {
          'no-unused-expressions': 'off'
        }
      },
    ]
  };
  