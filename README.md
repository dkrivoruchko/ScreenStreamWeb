![](img/about_image_full.png)
# ScreenStream Server & Web Client
A Server and Web Client to view streams from [ScreenStream](https://github.com/dkrivoruchko/ScreenStream) mobile application.<br>Available at [https://screenstream.io](https://screenstream.io)

## Description

The [ScreenStream](https://github.com/dkrivoruchko/ScreenStream) Android application is an open-source tool that enables you to stream your Android device's screen directly to your web browser.<br>The three main components of the application are:

- **ScreenStream**: Android application that serves as the source for streaming and includes various parameters that control the streaming process.
- **Server**: Acts as an intermediate signaling server, facilitating communication between the ScreenStream application and the Web Client.
- **Web Client**: The Web Client offers a user-friendly interface through which you can view live streams from the ScreenStream application.

The [ScreenStream](https://github.com/dkrivoruchko/ScreenStream) application and its components provide a practical way to share your Android device's screen with others, making it useful for various purposes, such as presentations, collaborative work, troubleshooting, or simply sharing your mobile experiences.

The application utilizes WebRTC technology for streaming and ensures end-to-end encryption for secure data transmission from the mobile app directly to the Web Client. There is no intermediary server involved in the process; the stream data is sent directly from the mobile application to the Web Client.

The application only requires the ScreenStream Android app itself, a web browser, and an internet connection to work seamlessly. It offers a convenient solution for remotely accessing and utilizing your Android device without any additional software.

This repository contains the source code for both the Server and Web Client components of the ScreenStream application. The source code for the ScreenStream application is available in a [separate repository](https://github.com/dkrivoruchko/ScreenStream).

## Environment variables

Set the following environment variables before starting the server. The required variables configure the public hostname, Android Play Integrity verification, Cloudflare Turnstile, and TURN credentials.

| Variable | Required | Description | Example |
| --- | --- | --- | --- |
| `SERVER_ORIGIN` | Yes | Public server hostname, without a protocol. Also used for JWT validation, Turnstile hostname validation, and the TURN hostname (`turn.<SERVER_ORIGIN>`). | `screenstream.example.com` |
| `ANDROID_APP_PACKAGE` | Yes | Android application package name expected in Play Integrity tokens and host JWTs. | `info.dvkr.screenstream` |
| `ANDROID_APP_CERT256` | Yes | SHA-256 certificate digest expected in the Play Integrity response. | `base64-encoded-digest` |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Yes | Google service account email with access to the Play Integrity API. | `service-account@example.iam.gserviceaccount.com` |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Yes | Google service account private key. Store line breaks as literal `\n` sequences. | `-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n` |
| `TURNSTYLE_SITE_KEY` | Yes | Cloudflare Turnstile site key embedded in the web client. | `0x4AAAA...` |
| `TURNSTYLE_SECRET_KEY` | Yes | Cloudflare Turnstile secret key used for server-side token validation. | `0x4AAAA...` |
| `TURN_SHARED_SECRET` | Yes | Shared secret used to generate temporary TURN credentials. It must match the secret configured on the TURN server. | `a-long-random-secret` |
| `PORT` | No | HTTP server port. Defaults to `5000`. | `5000` |
| `APP_NAME` | No | Service and hostname name attached to server logs. | `ScreenStream-DEV` |
| `LOG_LEVEL` | No | Server log level. Defaults to `info` when `APP_NAME` contains `PROD`, otherwise `debug`. | `info` |
| `DD_API_KEY` | No | Datadog API key. When omitted, server logs are written to the console. | `datadog-api-key` |
| `DD_BROWSER_LOG_LEVEL` | No | Datadog Browser SDK log level. Defaults to `info` for `screenstream.io`, otherwise `debug`. | `info` |

For example, configure the variables in the shell and start the server with npm:

```bash
export SERVER_ORIGIN=screenstream.example.com
export ANDROID_APP_PACKAGE=info.dvkr.screenstream
export ANDROID_APP_CERT256=base64-encoded-digest
export GOOGLE_SERVICE_ACCOUNT_EMAIL=service-account@example.iam.gserviceaccount.com
export GOOGLE_SERVICE_ACCOUNT_KEY='-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n'
export TURNSTYLE_SITE_KEY=0x4AAAA...
export TURNSTYLE_SECRET_KEY=0x4AAAA...
export TURN_SHARED_SECRET=a-long-random-secret

npm install
npm start
```

`npm start` automatically provides `npm_package_version`, which is used in server and browser logs. The project does not load `.env` files itself; use shell variables or your deployment platform's environment configuration.

## Contribution

To contribute with translation, kindly translate the following file:

https://github.com/dkrivoruchko/ScreenStreamWeb/blob/main/src/client/static/lang/en.json

Then, please, [make a pull request](https://help.github.com/en/articles/creating-a-pull-request) or send the translated file to the developer via e-mail <dkrivoruchko@gmail.com> as an attachment.

Your contribution is valuable and will help improve the accessibility of the application. Thank you for your efforts!

## Developed By

Developed by [Dmytro Kryvoruchko](dkrivoruchko@gmail.com). If there are any issues or ideas, feel free to contact me.

## Privacy Policy and Terms & Conditions

By joining stream, you agree to [Privacy Policy](https://screenstream.io/privacy.html) and [Terms & Conditions](https://screenstream.io/terms.html)

## License

```
The MIT License (MIT)

Copyright (c) 2023 Dmytro Kryvoruchko

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
