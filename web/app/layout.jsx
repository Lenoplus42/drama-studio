import "./globals.css";

export const metadata = {
  title: "Drama Studio",
  description: "Write a multi-voice scene and hear it performed by Drama3, running on-device with MLX.",
};

export const viewport = {
  themeColor: "#14161b",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:ital,wght@1,600;1,700;1,800&family=Titillium+Web:ital,wght@0,400;0,600;0,700;1,400&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
