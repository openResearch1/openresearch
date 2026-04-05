import { ComponentProps } from "solid-js"

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 16 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path data-slot="logo-logo-mark-shadow" d="M12 16H4V8H12V16Z" fill="var(--icon-weak-base)" />
      <path data-slot="logo-logo-mark-o" d="M12 4H4V16H12V4ZM16 20H0V0H16V20Z" fill="var(--icon-strong-base)" />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 80 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M60 80H20V40H60V80Z" fill="var(--icon-base)" />
      <path d="M60 20H20V80H60V20ZM80 100H0V0H80V100Z" fill="var(--icon-strong-base)" />
    </svg>
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 354 42"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <g>
        {/* O */}
        <path d="M18 30H6V18H18V30Z" fill="var(--icon-weak-base)" />
        <path d="M18 12H6V30H18V12ZM24 36H0V6H24V36Z" fill="var(--icon-base)" />
        {/* P */}
        <path d="M48 30H36V18H48V30Z" fill="var(--icon-weak-base)" />
        <path d="M36 30H48V12H36V30ZM54 36H36V42H30V6H54V36Z" fill="var(--icon-base)" />
        {/* E */}
        <path d="M84 24V30H66V24H84Z" fill="var(--icon-weak-base)" />
        <path d="M84 24H66V30H84V36H60V6H84V24ZM66 18H78V12H66V18Z" fill="var(--icon-base)" />
        {/* N */}
        <path d="M108 36H96V18H108V36Z" fill="var(--icon-weak-base)" />
        <path d="M108 12H96V36H90V6H108V12ZM114 36H108V12H114V36Z" fill="var(--icon-base)" />
        {/* R */}
        <path d="M138 18H126V12H138V18Z" fill="var(--icon-weak-base)" />
        <path d="M144 24H132V30H126V36H120V6H144V24ZM138 12H126V18H138V12ZM144 36H132V30H144V36Z" fill="var(--icon-strong-base)" />
        {/* E */}
        <path d="M174 24V30H156V24H174Z" fill="var(--icon-weak-base)" />
        <path d="M174 24H156V30H174V36H150V6H174V24ZM156 18H168V12H156V18Z" fill="var(--icon-strong-base)" />
        {/* S */}
        <path d="M204 18H186V12H204V18ZM198 30H180V24H198V30Z" fill="var(--icon-weak-base)" />
        <path d="M204 6V12H186V18H204V36H180V30H198V24H180V6H204Z" fill="var(--icon-strong-base)" />
        {/* E */}
        <path d="M234 24V30H216V24H234Z" fill="var(--icon-weak-base)" />
        <path d="M234 24H216V30H234V36H210V6H234V24ZM216 18H228V12H216V18Z" fill="var(--icon-strong-base)" />
        {/* A */}
        <path d="M258 18H246V12H258V18ZM258 36H246V24H258V36Z" fill="var(--icon-weak-base)" />
        <path d="M264 36H240V6H264V36ZM258 12H246V18H258V12ZM258 24H246V36H258V24Z" fill="var(--icon-strong-base)" />
        {/* R */}
        <path d="M288 18H276V12H288V18Z" fill="var(--icon-weak-base)" />
        <path d="M294 24H282V30H276V36H270V6H294V24ZM288 12H276V18H288V12ZM294 36H282V30H294V36Z" fill="var(--icon-strong-base)" />
        {/* C */}
        <path d="M324 30H306V18H324V30Z" fill="var(--icon-weak-base)" />
        <path d="M324 12H306V30H324V36H300V6H324V12Z" fill="var(--icon-strong-base)" />
        {/* H */}
        <path d="M348 18H336V6H348V18ZM348 36H336V24H348V36Z" fill="var(--icon-weak-base)" />
        <path d="M354 36H330V6H354V36ZM348 6H336V18H348V6ZM348 24H336V36H348V24Z" fill="var(--icon-strong-base)" />
      </g>
    </svg>
  )
}
