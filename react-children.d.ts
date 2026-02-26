// FIXME: I have no idea why this is needed, but for some reason without it,
// there's a bunch of errors about how "Element[] is not assignable to type ReactNode".

import "react";

declare module "react" {
  interface HTMLAttributes<T> {
    children?: React.ReactNode | React.ReactNode[];
  }
}
