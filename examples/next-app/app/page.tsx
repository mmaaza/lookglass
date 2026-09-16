import { ViewerShell } from '@/components/viewer-shell';

/**
 * A server component that renders a client viewer. This works because the
 * package root is server-safe and only `lookglass/react` carries
 * "use client" — which is what the preserved directives in the build exist to
 * guarantee.
 */
export default function Page() {
  return <ViewerShell />;
}
