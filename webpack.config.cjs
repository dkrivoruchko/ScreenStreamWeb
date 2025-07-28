const path = require('path');

module.exports = {
    entry: './src/client/static/src/main.js',
    output: {
        path: path.resolve(__dirname, './src/client/static'),
        filename: 'bundle.js',
    },
    module: {
        rules: [
            {
                test: /\.(js)$/,
                exclude: /node_modules/,
                use: ['babel-loader'],
            },
        ],
    },
    mode: 'production'
};