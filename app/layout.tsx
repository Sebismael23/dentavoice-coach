import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'DentaVoice Coach',
  description: 'Real-time sales coach for DentaVoice calls',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-bg text-text-primary antialiased font-sans min-h-screen">
        {children}
      </body>
    </html>
  );
}
