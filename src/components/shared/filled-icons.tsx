import { useId, type SVGProps } from "react";

/**
 * Filled icons Tabler doesn't ship.
 *
 * Every one of these is an adaptation of the outline glyph the app used
 * before, drawn so the menus can be uniformly filled — see
 * docs/ui-refresh-backlog.md for which shape each one is built from and
 * why. Geometry lives on Tabler's own 24x24 grid, so they drop in
 * wherever a Tabler icon did.
 *
 * Sign-out and sign-in are deliberately absent: a door is defined by its
 * walls rather than its mass, so those two stay stroked and only get a
 * heavier `stroke={2.3}`.
 *
 * Several icons punch holes with a `<mask>`, whose id has to be unique
 * per instance — the same icon can appear twice on a page, and duplicate
 * ids make the second one reuse the first one's mask. Hence `useId()`.
 */
export type FilledIconProps = SVGProps<SVGSVGElement>;

function iconProps(props: FilledIconProps) {
  return {
    viewBox: "0 0 24 24",
    width: 24,
    height: 24,
    fill: "currentColor",
    "aria-hidden": true,
    ...props,
  };
}

export function IconRadioFilled(props: FilledIconProps) {
  const uid = useId();
  return (
    <svg {...iconProps(props)}>
      <mask
        id={`${uid}m1`}
        maskUnits="userSpaceOnUse"
        x="0"
        y="0"
        width="24"
        height="24"
      >
        <rect width="24" height="24" fill="#fff" />
        <rect x="5.5" y="9.5" width="2.6" height="4" rx="1.3" fill="#000" />
        <circle cx="13.6" cy="16.3" r="1.2" fill="#000" />
        <circle cx="17.4" cy="16.3" r="1.2" fill="#000" />
      </mask>
      <g mask={`url(#${uid}m1)`}>
        <path d="M14.35 2.05a1 1 0 0 1 .72 1.86l-5.85 2.29h-5.4z" />
        <rect x="2.8" y="6.2" width="18.4" height="13.8" rx="2.4" />
      </g>
    </svg>
  );
}

export function IconHeartOffFilled(props: FilledIconProps) {
  const uid = useId();
  return (
    <svg {...iconProps(props)}>
      <mask
        id={`${uid}m2`}
        maskUnits="userSpaceOnUse"
        x="0"
        y="0"
        width="24"
        height="24"
      >
        <rect width="24" height="24" fill="#fff" />
        <path
          d="M13.4 2.6 10.1 8.4l3.4 2.1 -3.9 4.6 3 2.4 -4.4 5.5"
          fill="none"
          stroke="#000"
          strokeWidth="2.6"
          strokeLinejoin="round"
        />
      </mask>
      <g mask={`url(#${uid}m2)`}>
        <path d="M6.979 3.074a6 6 0 0 1 4.988 1.425l.037 .033l.034 -.03a6 6 0 0 1 4.733 -1.44l.246 .036a6 6 0 0 1 3.364 10.008l-.18 .185l-.048 .041l-7.45 7.379a1 1 0 0 1 -1.313 .082l-.094 -.082l-7.493 -7.422a6 6 0 0 1 3.176 -10.215z" />
      </g>
    </svg>
  );
}

export function IconPlaylistAddFilled(props: FilledIconProps) {
  const uid = useId();
  return (
    <svg {...iconProps(props)}>
      <mask
        id={`${uid}m3`}
        maskUnits="userSpaceOnUse"
        x="0"
        y="0"
        width="24"
        height="24"
      >
        <rect width="24" height="24" fill="#fff" />
        <circle cx="17.6" cy="16.4" r="5.6" fill="#000" />
      </mask>
      <g mask={`url(#${uid}m3)`}>
        <rect x="3" y="7" width="16" height="2" rx="1" />
        <rect x="3" y="11" width="10" height="2" rx="1" />
        <rect x="3" y="15" width="8" height="2" rx="1" />
      </g>
      <mask
        id={`${uid}m4`}
        maskUnits="userSpaceOnUse"
        x="0"
        y="0"
        width="24"
        height="24"
      >
        <rect width="24" height="24" fill="#fff" />
        <rect
          x="16.75"
          y="13.2"
          width="1.7"
          height="6.4"
          rx=".85"
          fill="#000"
        />
        <rect
          x="14.4"
          y="15.55"
          width="6.4"
          height="1.7"
          rx=".85"
          fill="#000"
        />
      </mask>
      <g mask={`url(#${uid}m4)`}>
        <circle cx="17.6" cy="16.4" r="4.4" />
      </g>
    </svg>
  );
}

export function IconPlaylistXFilled(props: FilledIconProps) {
  const uid = useId();
  return (
    <svg {...iconProps(props)}>
      <mask
        id={`${uid}m5`}
        maskUnits="userSpaceOnUse"
        x="0"
        y="0"
        width="24"
        height="24"
      >
        <rect width="24" height="24" fill="#fff" />
        <circle cx="17.6" cy="16.4" r="5.6" fill="#000" />
      </mask>
      <g mask={`url(#${uid}m5)`}>
        <rect x="3" y="7" width="16" height="2" rx="1" />
        <rect x="3" y="11" width="10" height="2" rx="1" />
        <rect x="3" y="15" width="8" height="2" rx="1" />
      </g>
      <mask
        id={`${uid}m6`}
        maskUnits="userSpaceOnUse"
        x="0"
        y="0"
        width="24"
        height="24"
      >
        <rect width="24" height="24" fill="#fff" />
        <rect
          x="16.75"
          y="13.2"
          width="1.7"
          height="6.4"
          rx=".85"
          fill="#000"
          transform="rotate(45 17.6 16.4)"
        />
        <rect
          x="16.75"
          y="13.2"
          width="1.7"
          height="6.4"
          rx=".85"
          fill="#000"
          transform="rotate(-45 17.6 16.4)"
        />
      </mask>
      <g mask={`url(#${uid}m6)`}>
        <circle cx="17.6" cy="16.4" r="4.4" />
      </g>
    </svg>
  );
}

export function IconShare3Filled(props: FilledIconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M13 4v4c-6.575 1.028 -9.02 6.788 -10 12c-.037 .206 5.384 -5.962 10 -6v4l8 -7z" />
    </svg>
  );
}

export function IconPowerFilled(props: FilledIconProps) {
  return (
    <svg {...iconProps(props)}>
      <path
        d="M7 6.5a7.6 7.6 0 1 0 10 0"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
      <rect x="10.7" y="2.6" width="2.6" height="9.6" rx="1.3" />
    </svg>
  );
}

export function IconUserPlusFilled(props: FilledIconProps) {
  const uid = useId();
  return (
    <svg {...iconProps(props)}>
      <mask
        id={`${uid}m7`}
        maskUnits="userSpaceOnUse"
        x="0"
        y="0"
        width="24"
        height="24"
      >
        <rect width="24" height="24" fill="#fff" />
        <circle cx="18.4" cy="17.8" r="5.5" fill="#000" />
      </mask>
      <g mask={`url(#${uid}m7)`}>
        <path d="M11 2.6a4.4 4.4 0 1 1 -4.4 4.4a4.4 4.4 0 0 1 4.4 -4.4z" />
        <path d="M12.8 13.6a4.6 4.6 0 0 1 4.6 4.6v.9a2 2 0 0 1 -2 2h-8.8a2 2 0 0 1 -2 -2v-.9a4.6 4.6 0 0 1 4.6 -4.6z" />
      </g>
      <mask
        id={`${uid}m8`}
        maskUnits="userSpaceOnUse"
        x="0"
        y="0"
        width="24"
        height="24"
      >
        <rect width="24" height="24" fill="#fff" />
        <rect
          x="17.55"
          y="14.6"
          width="1.7"
          height="6.4"
          rx=".85"
          fill="#000"
        />
        <rect
          x="15.2"
          y="16.95"
          width="6.4"
          height="1.7"
          rx=".85"
          fill="#000"
        />
      </mask>
      <g mask={`url(#${uid}m8)`}>
        <circle cx="18.4" cy="17.8" r="4.4" />
      </g>
    </svg>
  );
}

export function IconUserCogFilled(props: FilledIconProps) {
  const uid = useId();
  return (
    <svg {...iconProps(props)}>
      <mask
        id={`${uid}m9`}
        maskUnits="userSpaceOnUse"
        x="0"
        y="0"
        width="24"
        height="24"
      >
        <rect width="24" height="24" fill="#fff" />
        <circle cx="18.4" cy="17.8" r="5.6" fill="#000" />
      </mask>
      <g mask={`url(#${uid}m9)`}>
        <path d="M11 2.6a4.4 4.4 0 1 1 -4.4 4.4a4.4 4.4 0 0 1 4.4 -4.4z" />
        <path d="M12.8 13.6a4.6 4.6 0 0 1 4.6 4.6v.9a2 2 0 0 1 -2 2h-8.8a2 2 0 0 1 -2 -2v-.9a4.6 4.6 0 0 1 4.6 -4.6z" />
      </g>
      <g transform="translate(13.6 13) scale(.4)">
        <path d="M14.647 4.081a.724 .724 0 0 0 1.08 .448c2.439 -1.485 5.23 1.305 3.745 3.744a.724 .724 0 0 0 .447 1.08c2.775 .673 2.775 4.62 0 5.294a.724 .724 0 0 0 -.448 1.08c1.485 2.439 -1.305 5.23 -3.744 3.745a.724 .724 0 0 0 -1.08 .447c-.673 2.775 -4.62 2.775 -5.294 0a.724 .724 0 0 0 -1.08 -.448c-2.439 1.485 -5.23 -1.305 -3.745 -3.744a.724 .724 0 0 0 -.447 -1.08c-2.775 -.673 -2.775 -4.62 0 -5.294a.724 .724 0 0 0 .448 -1.08c-1.485 -2.439 1.305 -5.23 3.744 -3.745a.722 .722 0 0 0 1.08 -.447c.673 -2.775 4.62 -2.775 5.294 0zm-2.647 4.919a3 3 0 1 0 0 6a3 3 0 0 0 0 -6" />
      </g>
    </svg>
  );
}

export function IconUsersGroupFilled(props: FilledIconProps) {
  const uid = useId();
  return (
    <svg {...iconProps(props)}>
      <mask
        id={`${uid}m10`}
        maskUnits="userSpaceOnUse"
        x="0"
        y="0"
        width="24"
        height="24"
      >
        <rect width="24" height="24" fill="#fff" />
        <circle cx="12" cy="12.6" r="3.6" fill="#000" />
        <path d="M6 22v-3.6a6 6 0 0 1 12 0v3.6z" fill="#000" />
      </mask>
      <g mask={`url(#${uid}m10)`}>
        <circle cx="5.6" cy="6.3" r="2.9" />
        <path d="M5.6 9.9c1.9 0 3.4 1.1 3.4 2.6v3.9h-6.2a1 1 0 0 1 -1 -1v-2.9c0 -1.5 1.9 -2.6 3.8 -2.6z" />
        <circle cx="18.4" cy="6.3" r="2.9" />
        <path d="M18.4 9.9c1.9 0 3.8 1.1 3.8 2.6v2.9a1 1 0 0 1 -1 1h-6.2v-3.9c0 -1.5 1.5 -2.6 3.4 -2.6z" />
      </g>
      <circle cx="12" cy="12.6" r="2.9" />
      <path d="M12 16.2a4.6 4.6 0 0 1 4.6 4.6v.2a1 1 0 0 1 -1 1h-7.2a1 1 0 0 1 -1 -1v-.2a4.6 4.6 0 0 1 4.6 -4.6z" />
    </svg>
  );
}

export function IconEyeOffFilled(props: FilledIconProps) {
  const uid = useId();
  return (
    <svg {...iconProps(props)}>
      <mask
        id={`${uid}m11`}
        maskUnits="userSpaceOnUse"
        x="0"
        y="0"
        width="24"
        height="24"
      >
        <rect width="24" height="24" fill="#fff" />
        <path d="M.97 4.23 4.23 .97 23.03 19.77 19.77 23.03z" fill="#000" />
      </mask>
      <g mask={`url(#${uid}m11)`}>
        <path d="M12 4c4.29 0 7.863 2.429 10.665 7.154l.22 .379l.045 .1l.03 .083l.014 .055l.014 .082l.011 .1v.11l-.014 .111a.992 .992 0 0 1 -.026 .11l-.039 .108l-.036 .075l-.016 .03c-2.764 4.836 -6.3 7.38 -10.555 7.499l-.313 .004c-4.396 0 -8.037 -2.549 -10.868 -7.504a1 1 0 0 1 0 -.992c2.831 -4.955 6.472 -7.504 10.868 -7.504zm0 5a3 3 0 1 0 0 6a3 3 0 0 0 0 -6" />
      </g>
      <path d="M3.29 4.71a1 1 0 1 1 1.42 -1.42l16 16a1 1 0 0 1 -1.42 1.42z" />
    </svg>
  );
}

export function IconPinnedOffFilled(props: FilledIconProps) {
  const uid = useId();
  return (
    <svg {...iconProps(props)}>
      <mask
        id={`${uid}m12`}
        maskUnits="userSpaceOnUse"
        x="0"
        y="0"
        width="24"
        height="24"
      >
        <rect width="24" height="24" fill="#fff" />
        <path d="M.97 4.23 4.23 .97 23.03 19.77 19.77 23.03z" fill="#000" />
      </mask>
      <g mask={`url(#${uid}m12)`}>
        <path d="M15.113 3.21l.094 .083l5.5 5.5a1 1 0 0 1 -1.175 1.59l-3.172 3.171l-1.424 3.797a1 1 0 0 1 -.158 .277l-.07 .08l-1.5 1.5a1 1 0 0 1 -1.32 .082l-.095 -.083l-2.793 -2.792l-3.793 3.792a1 1 0 0 1 -1.497 -1.32l.083 -.094l3.792 -3.793l-2.792 -2.793a1 1 0 0 1 -.083 -1.32l.083 -.094l1.5 -1.5a1 1 0 0 1 .258 -.187l.098 -.042l3.796 -1.425l3.171 -3.17a1 1 0 0 1 1.497 -1.26z" />
      </g>
      <path d="M3.29 4.71a1 1 0 1 1 1.42 -1.42l16 16a1 1 0 0 1 -1.42 1.42z" />
    </svg>
  );
}

export function IconBrandSafariFilled(props: FilledIconProps) {
  const uid = useId();
  return (
    <svg {...iconProps(props)}>
      <mask
        id={`${uid}m13`}
        maskUnits="userSpaceOnUse"
        x="0"
        y="0"
        width="24"
        height="24"
      >
        <rect width="24" height="24" fill="#fff" />
        <path d="M16.9 7.1 14 14l-6.9 2.9 2.9 -6.9z" fill="#000" />
      </mask>
      <g mask={`url(#${uid}m13)`}>
        <circle cx="12" cy="12" r="9.3" />
      </g>
    </svg>
  );
}

export function IconVolumeFilled(props: FilledIconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M11.2 4.08a.8 .8 0 0 1 1.3 .62v14.6a.8 .8 0 0 1 -1.3 .62l-3.9 -3.92h-2.7a1.6 1.6 0 0 1 -1.6 -1.6v-4.8a1.6 1.6 0 0 1 1.6 -1.6h2.7z" />
      <path
        d="M15 8a5 5 0 0 1 0 8"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
      />
      <path
        d="M17.7 5a9 9 0 0 1 0 14"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconVolume2Filled(props: FilledIconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M11.2 4.08a.8 .8 0 0 1 1.3 .62v14.6a.8 .8 0 0 1 -1.3 .62l-3.9 -3.92h-2.7a1.6 1.6 0 0 1 -1.6 -1.6v-4.8a1.6 1.6 0 0 1 1.6 -1.6h2.7z" />
      <path
        d="M15 8a5 5 0 0 1 0 8"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconVolume3Filled(props: FilledIconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M11.2 4.08a.8 .8 0 0 1 1.3 .62v14.6a.8 .8 0 0 1 -1.3 .62l-3.9 -3.92h-2.7a1.6 1.6 0 0 1 -1.6 -1.6v-4.8a1.6 1.6 0 0 1 1.6 -1.6h2.7z" />
      <rect
        x="15.2"
        y="11"
        width="6.4"
        height="2"
        rx="1"
        transform="rotate(45 18.4 12)"
      />
      <rect
        x="15.2"
        y="11"
        width="6.4"
        height="2"
        rx="1"
        transform="rotate(-45 18.4 12)"
      />
    </svg>
  );
}

export function IconMusicFilled(props: FilledIconProps) {
  return (
    <svg {...iconProps(props)}>
      <ellipse cx="6.2" cy="17" rx="3.2" ry="2.8" />
      <ellipse cx="16.2" cy="17" rx="3.2" ry="2.8" />
      <path d="M7.6 3.2h11.8v4.4H7.6z" />
      <rect x="7.6" y="3.2" width="1.8" height="14.2" />
      <rect x="17.6" y="3.2" width="1.8" height="14.2" />
    </svg>
  );
}

export function IconPlugConnectedXFilled(props: FilledIconProps) {
  const uid = useId();
  return (
    <svg {...iconProps(props)}>
      <mask
        id={`${uid}m14`}
        maskUnits="userSpaceOnUse"
        x="0"
        y="0"
        width="24"
        height="24"
      >
        <rect width="24" height="24" fill="#fff" />
        <circle cx="18.6" cy="18.2" r="4.9" fill="#000" />
      </mask>
      <g mask={`url(#${uid}m14)`}>
        <path d="M9.785 6 18 14.215l-2.054 2.054a5.81 5.81 0 1 1 -8.215 -8.215z" />
        <path
          d="M15 4l-3.5 3.5M20 9l-3.5 3.5M4 20l3.5 -3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
        />
      </g>
      <rect
        x="15.5"
        y="17.1"
        width="6.2"
        height="2.2"
        rx="1.1"
        transform="rotate(45 18.6 18.2)"
      />
      <rect
        x="15.5"
        y="17.1"
        width="6.2"
        height="2.2"
        rx="1.1"
        transform="rotate(-45 18.6 18.2)"
      />
    </svg>
  );
}

export function IconToolFilled(props: FilledIconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M7 10h3v-3l-3.5 -3.5a6 6 0 0 1 8 8l6 6a2 2 0 0 1 -3 3l-6 -6a6 6 0 0 1 -8 -8l3.5 3.5z" />
    </svg>
  );
}
