import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'character.quilt · design engine',
  description: 'Describe a campaign, review what the agent made, ship it.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
