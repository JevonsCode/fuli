# DingDong Selection Plugin

<!-- impeccable:product-schema 1 -->

## Platform

macOS native menu bar application, with a secondary web runtime demonstration

## Stack

The installable product uses native Swift, AppKit, Accessibility, Security/Keychain, and URLSession with no third-party dependencies. Plain JavaScript, HTML, and CSS remain only for the secondary browser runtime demonstration.

## Users

People selecting text in any macOS application who want to copy, translate, or understand it without leaving their current context.

## Product Purpose

Turn a system-wide macOS text selection into three explicit actions: copy the original, request a translation, or request an explanation. The package also proves that DingDong can scope and deliver a reusable system-selection procedure.

## Positioning

The visible selection tool is a lightweight native menu bar agent. macOS Accessibility reads the current selection, Keychain protects cloud tokens, and explicit Provider adapters perform translation or explanation. The JavaScript manifest runtime remains a secondary capability-routing example.

## Operating Context

The tool builds and installs as a local macOS application from inside the FULI repository. DingDong manages its companion Skill and project scope. Installation does not change any browser, Git, or GitLab configuration.

## Capabilities and Constraints

- Copy uses the system pasteboard after an explicit click or `⌥⌘C` shortcut.
- Translate and explain support local Ollama/LM Studio or user-configured OpenAI-compatible cloud Providers. No token or provider is silently assumed.
- Tokens live only in macOS Keychain; remote HTTP is rejected and local HTTP is limited to loopback hosts.
- The native agent has no polling loop, Electron, WebKit, resident model, clipboard history, or persistent selected text.
- When a text-service endpoint is absent, the UI reports that configuration is required; it does not fabricate output.
- Plugin manifests, permissions, lifecycle, and command input are validated before execution.
- The example does not read existing credentials, Git configuration, browser storage, clipboard history, or unrelated local files.
- No GitLab operation, staging, commit, or push is part of the workflow.

## Evidence on Hand

The user explicitly requested a selection-based copy/translate/explain example, DingDong integration, automated Agent recruitment, and truthful execution reporting on 2026-08-27. No production translation provider, customer claim, benchmark, or deployment target was supplied.

## Product Principles

- Keep the reader in context.
- Make every external capability explicit and permissioned.
- Prefer an honest unavailable state over synthetic answers.
- Separate plugin behavior from host adapters so each side can be tested.
- Treat configuration and actual execution as different states.

## Accessibility & Inclusion

Keyboard operation, visible focus, semantic status messages, reduced-motion support, and responsive layout are required for the example.
