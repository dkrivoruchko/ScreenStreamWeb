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
