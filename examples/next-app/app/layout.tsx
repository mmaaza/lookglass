import type { Metadata } from 'next';
import 'lookglass/styles.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'lookglass playground',
  description: 'Offline-capable all-in-one file viewer',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
