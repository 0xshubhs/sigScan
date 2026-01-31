const path = require('path');

module.exports = {
  target: 'node',
  mode: 'development',
  entry: {
    'extension/extension': './src/extension/extension.ts',
    'cli/index': './src/cli/index.ts'
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
    libraryTarget: 'commonjs2'
  },
  externals: {
    vscode: 'commonjs vscode',
    sqlite3: 'commonjs sqlite3',
    fsevents: 'commonjs fsevents'
    // NOTE: solc is now bundled, not external
  },
  resolve: {
    extensions: ['.ts', '.js'],
    fallback: {
      fsevents: false
    }
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: [/node_modules/, /__tests__/, /\.test\.ts$/, /\.spec\.ts$/],
        use: 'ts-loader'
      }
    ]
  },
  devtool: 'source-map',
  ignoreWarnings: [
    {
      module: /node_modules\/chokidar/,
      message: /Can't resolve 'fsevents'/,
    },
  ]
};
