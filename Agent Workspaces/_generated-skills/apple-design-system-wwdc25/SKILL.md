---
name: apple-design-system-wwdc25
description: Applies Apple's WWDC25 design-system guidance ("Get to know the new design system", session 356) and AppKit new-design guidance ("Build an AppKit app with the new design", session 310) to native Apple app UI as implementation checks. Use when designing, reviewing, or refactoring SwiftUI, UIKit, AppKit, or Catalyst UI for iOS, iPadOS, macOS (Tahoe), visionOS, watchOS, or tvOS involving Liquid Glass, toolbars, tab bars, sidebars, inspectors, sheets, popovers, scroll edge effects, concentric shapes, materials, icons/SF Symbols, controls, onboarding, settings, responsive layout, cross-device continuity, or HIG-quality polish; and for macOS AppKit work with NSToolbar, NSToolbarItemGroup, NSItemBadge, NSSplitViewController, split-item/titlebar accessories, NSBackgroundExtensionView, NSView.LayoutRegion, prefersCompactControlSizeMetrics, borderShape, tint prominence, slider neutralValue, NSGlassEffectView, NSGlassEffectContainerView, NSVisualEffectView, NSAppearance, scroll edge behavior, and AppKit/SwiftUI interop.
---

# Apple Design System WWDC25 (+ AppKit New Design)

Use this skill whenever designing, reviewing, or refactoring UI for Apple platforms, and whenever building, refactoring, or reviewing macOS AppKit UI for the current Apple design system. It turns two WWDC25 sessions into implementation checks:

- **Session 356, "Get to know the new design system"** — cross-platform design language, structure, and continuity.
- **Session 310, "Build an AppKit app with the new design"** — AppKit-specific APIs and Mac implementation.

For broader HIG coverage, also use `apple-human-interface-guidelines`. When a macOS UI is SwiftUI-first with AppKit interop, also use `build-macos-apps:swiftui-patterns`; when bridging AppKit views into SwiftUI or SwiftUI into AppKit, also use `build-macos-apps:appkit-interop`.

## Sources

Primary sources:
- Get to know the new design system (session 356): https://developer.apple.com/videos/play/wwdc2025/356/ — themes: design language, structure, continuity. Key concepts: Liquid Glass as a functional layer, concentric shapes, refined color and typography, grouped bars, source-anchored sheets, scroll edge effects, inset sidebars, background extension, shared anatomy across devices, symbol/text clarity, and continuity across iPhone, iPad, and Mac.
- Build an AppKit app with the new design (session 310): https://developer.apple.com/videos/play/wwdc2025/310/ — chapters: App structure, scroll edge effect, controls, glass, next steps. Major API themes: `NSToolbarItem`, `NSToolbarItemGroup`, `NSItemBadge`, `NSSplitViewController`, split item accessories, `NSBackgroundExtensionView`, `NSView.LayoutRegion`, `prefersCompactControlSizeMetrics`, control border shapes, tint prominence, slider neutral values, `NSGlassEffectView`, and `NSGlassEffectContainerView`.

Linked Apple references to verify when needed:
- Adopting Liquid Glass: https://developer.apple.com/documentation/TechnologyOverviews/adopting-liquid-glass
- Liquid Glass overview: https://developer.apple.com/documentation/technologyoverviews/liquid-glass
- Applying Liquid Glass to custom views (SwiftUI): https://developer.apple.com/documentation/swiftui/applying-liquid-glass-to-custom-views
- HIG Toolbars: https://developer.apple.com/design/human-interface-guidelines/toolbars
- HIG Icons: https://developer.apple.com/design/human-interface-guidelines/icons
- HIG Materials: https://developer.apple.com/design/human-interface-guidelines/materials
- Designing for macOS: https://developer.apple.com/design/human-interface-guidelines/designing-for-macos
- Human Interface Guidelines (root): https://developer.apple.com/design/human-interface-guidelines/
- AppKit: https://developer.apple.com/documentation/AppKit
- NSGlassEffectView: https://developer.apple.com/documentation/appkit/nsglasseffectview
- NSGlassEffectContainerView: https://developer.apple.com/documentation/appkit/nsglasseffectcontainerview
- NSBackgroundExtensionView: https://developer.apple.com/documentation/AppKit/NSBackgroundExtensionView

Source-attribution guidance: for source links in an answer, cite the WWDC session first (356 for cross-platform principles, 310 for AppKit APIs), then the specific Apple reference page. If Apple updates the HIG, re-check the linked pages before changing rules.

## Cross-platform workflow

1. Read the cross-platform rules below before making any Apple-platform UI change.
2. Identify the target platforms and input modes: iPhone, iPad, Mac, watchOS, tvOS, visionOS, pointer, touch, keyboard, controller, or focus.
3. Prefer standard SwiftUI, UIKit, AppKit, and Catalyst components before custom drawing. Let system bars, sheets, controls, sidebars, menus, and materials adopt the current design behavior.
4. Remove custom backgrounds, borders, dividers, and decorative overlays from navigation and control layers unless the product has a specific functional reason.
5. Treat Liquid Glass as a functional navigation/control layer above content, not as a decorative content material.
6. Build the app anatomy once, then adapt layout and density per device. Do not create separate unrelated UI systems for iPhone, iPad, and Mac.
7. Before finishing, run the Cross-platform Review Checklist and verify the changed UI on every relevant appearance, contrast, size class, and input mode.

## AppKit workflow

1. Read the AppKit rules below before changing AppKit UI.
2. Build or inspect with the current SDK first. Many toolbar, split-view, control, menu, and material updates are automatic.
3. Audit structure from the top down: window, toolbar, split view, sidebar/inspector, scroll views, accessory views, controls, menus, then custom glass.
4. Prefer AppKit-owned behaviors over custom effects. Remove legacy `NSVisualEffectView` sidebar material, custom toolbar backing, fixed control heights, and sibling-view glass hacks.
5. Use AppKit's new APIs only where they express intent: toolbar item grouping/prominence/badges, split item accessories, background extension, layout-region corner avoidance, compact metrics, border shape, tint prominence, neutral slider values, and glass effect containers.
6. Verify with real window resizing, edge-to-edge content, light/dark adaptive toolbar glass, keyboard/default-button behavior, pointer interaction, accessibility, and performance.

## Non-negotiables

Cross-platform:
- No dense wall-of-card Apple UI. Use structure, grouping, hierarchy, and native components instead of card-heavy decoration.
- No custom toolbar or tab-bar chrome that fights system materials.
- No Liquid Glass in the content layer except transient interactive cases such as active controls.
- No unlabeled or ambiguous symbols when text is clearer.
- No platform fork unless behavior genuinely differs. Keep shared anatomy and shared core interactions.
- No "looks good in one screenshot" signoff. Check window resizing, light/dark, increased contrast, reduced transparency, reduced motion, keyboard focus, and touch/pointer hit targets.

AppKit:
- Do not fake Liquid Glass with blur overlays or decorative translucent siblings.
- Do not put noninteractive toolbar titles/status labels on glass; make those toolbar items unbordered.
- Do not keep legacy sidebar `NSVisualEffectView` material when using new split-view sidebar glass.
- Do not hardcode AppKit control heights. Use Auto Layout and only opt into compact metrics for genuinely dense legacy panels.
- Do not add nearby multiple glass views without `NSGlassEffectContainerView`.
- Do not use Liquid Glass for regular content. Reserve it for top-level controls and navigation that float over content.

---

# Cross-platform rules (WWDC25 session 356)

Source basis: Apple WWDC25 session 356, "Get to know the new design system", plus its linked Apple HIG and Liquid Glass references.

## Design Language

1. Treat Liquid Glass as a system-level design update, not a visual effect to sprinkle around.
2. Use system components first. Standard controls, navigation, sheets, popovers, split views, tab bars, and toolbars inherit the new look and behavior when built with current SDKs.
3. Custom UI must harmonize with system rhythm: shape, spacing, typography, color, motion, depth, and input behavior need to feel native together.
4. Use system colors and semantic colors by default. If custom colors are necessary, provide light, dark, and increased-contrast variants.
5. Test custom color over material, transparency, and busy content. Legibility beats atmosphere.
6. Use stronger, clearer typography for key moments such as alerts, onboarding, and decision points.
7. Prefer left-aligned readable text in dense or instructional UI.
8. Do not scale font size with viewport width. Use Dynamic Type and platform text styles.
9. Avoid negative letter spacing. It fights system typography and harms readability.
10. Let system spacing and metrics drive layout. Avoid hardcoded control dimensions unless matching a measured platform requirement.

## Shape And Concentricity

1. Align nested shapes around a shared center where possible.
2. Use three shape ideas consistently:
   - Fixed-radius shapes for compact controls and dense layouts.
   - Capsules for controls whose radius is half their height.
   - Concentric shapes for nested surfaces where inner radius follows parent radius minus padding.
3. Use capsules for high-emphasis touch-friendly actions, sliders, switches, large buttons, and controls that need strong focus.
4. On macOS, small and medium dense controls can remain rounded rectangles; large or spacious controls can use capsules.
5. Use concentric inner radii for artwork inside cards, tiles inside panels, and nested containers.
6. Do not leave inner corners pinched, flared, or visually unrelated to the parent.
7. Near iPhone screen edges, favor capsule controls with enough margin from the display edge.
8. Near iPad or Mac window edges, align concentric shapes with the window or pane edge.
9. For reusable components that can be nested or standalone, use a concentric shape with a sensible fallback radius.
10. Do not use excessive rounding everywhere. Shape choice should express density, hierarchy, and platform context.

## Liquid Glass Layering

1. Liquid Glass belongs to functional elements such as navigation, controls, sidebars, bars, sheets, popovers, and transient interactive control states.
2. Do not use Liquid Glass as a background for normal content, data cards, prose, lists, dashboards, or decorative panels.
3. Standard materials belong inside the content layer when a content surface needs depth or separation.
4. Apply material to the control surface itself, not to arbitrary inner subviews.
5. Do not stack Liquid Glass layers on top of each other.
6. Avoid overusing custom Liquid Glass effects. Too much material distracts from content.
7. If multiple custom glass elements morph or interact, group them in the platform-supported container for better behavior and performance.
8. Always test reduced transparency and reduced motion. The design must remain understandable without full material and animation effects.
9. Treat focus state, overlap, and interaction as dynamic. Do not bake static translucency assumptions into screenshots or constants.
10. Controls should float above content only when that improves structure or access.

## Structure And Information Architecture

1. Navigation and controls form a functional layer above content. Keep the content layer and functional layer visually distinct.
2. Remove old custom toolbar, tab bar, sidebar, and navigation backgrounds unless still functionally required.
3. Do not express hierarchy with extra decoration. Prefer layout, grouping, position, and system tint.
4. Group toolbar items by function and frequency.
5. Avoid overcrowded bars. Move secondary actions into menus.
6. Do not group a text button and an icon button as if they are one combined action.
7. Primary actions should remain visually separate and clearly identifiable.
8. On iOS, make Search a first-class tab when search is a core persistent destination.
9. Tab bars are for persistent navigation, not screen-specific actions.
10. Accessory views in tab bars should support persistent app-wide experiences, not local commands.
11. Menus should use symbols where symbols improve scanning.
12. Closely related menu actions should not repeat near-identical symbols. Use one symbol to introduce the group and let labels distinguish actions.
13. Use standard selectors and platform APIs so common menu items can inherit standard glyphs and behavior.
14. Top contextual-menu actions should match the swipe actions for the same item.

## Sheets, Popovers, And Modality

1. Anchor action sheets and contextual surfaces to the element that caused them.
2. Specify the source view, item, or presentation anchor for action sheets and popovers.
3. A task that interrupts the main flow needs clearer focus, often with dimming and a stronger modal boundary.
4. A parallel task can separate from content with material without breaking the flow.
5. Half sheets and inset sheets need content behind them to remain visually intentional.
6. Check sheet edge content so controls do not collide with rounder corners.
7. Remove custom visual-effect backgrounds from popovers and sheets unless a real platform gap requires them.
8. When a sheet grows into deeper engagement, preserve focus and legibility through stronger opacity or system behavior.
9. Modal copy should be brief, specific, and action-oriented.
10. Do not make users hunt for the primary action in modal surfaces.

## Scroll Edges And Background Extension

1. Scroll edge effects clarify where floating UI meets content. They are not decoration.
2. Use scroll edge effects only when floating or pinned UI overlaps scrollable content.
3. Apply one scroll edge effect per view.
4. Do not mix or stack soft and hard edge effects in the same boundary.
5. Use soft edge effects for most iOS and iPadOS interactive overlap.
6. Use harder edge effects mainly on macOS when text, table headers, or controls need stronger separation.
7. In split views, each pane may have its own edge effect, but heights should align.
8. Sidebars can be inset and built with Liquid Glass so content can extend behind them.
9. Use background extension effects for expansive hero images, tinted backgrounds, or large visual surfaces.
10. Keep text and controls above background extension effects to avoid distortion or contrast loss.
11. Let scroll views extend beneath sidebars when discovery or continuity benefits.
12. Do not use blur as a divider replacement where there is no functional boundary.

## Layout And Continuity

1. Design the app anatomy once, then adapt the same anatomy across devices.
2. Preserve the user's task across device changes, window resizing, and layout transitions.
3. iPhone layouts are narrow and focused. Prioritize task clarity.
4. iPad is the adaptive middle ground. Support resizing and fluid column changes.
5. Mac is wide and expansive. Use density, inspector patterns, sidebars, and keyboard affordances appropriately.
6. Keep intentionally grouped content together as layout adapts.
7. Use the same symbols for the same concepts across devices.
8. Keep component anatomy stable: icon, label, accessory, selection marker, and state indicator should appear in familiar positions even when presentation changes.
9. Platform variation should express the same framework, not become a separate app.
10. Core interactions must remain the same even when the component form changes.
11. Selection, navigation, and state feedback should be consistent across tab bars, segmented controls, sidebars, menus, and lists.
12. Support arbitrary iPad and Mac window sizes instead of designing only for preset breakpoints.
13. Use split views and safe areas so the system can manage window controls, title bars, and resizing.

## Icons, Text, And Labels

1. Use SF Symbols and HIG-preferred glyphs for common actions where possible.
2. Symbols are good when the action has a widely recognized visual shorthand.
3. Use text labels when a symbol is ambiguous.
4. Do not use a pencil icon for every edit-like concept if the actual action could mean annotate, compose, modify, or select.
5. Do not use a checkmark for actions that could be confused with confirm, done, selected, or approve unless context is unmistakable.
6. In bars, symbol-heavy UI is acceptable only when recognition is strong and accessibility labels are correct.
7. Menus can use symbols for scanability, but text remains the precise contract.
8. Keep icon visual weight balanced. Do not assume equal frame size means equal perceived size.
9. Never rely on icon-only affordances without accessibility labels.
10. For destructive or security-sensitive actions, text clarity beats compactness.

## Controls (cross-platform)

1. Use standard Button, Toggle, Slider, Stepper, Picker, TextField, segmented controls, and platform equivalents whenever possible.
2. Do not hardcode control layout metrics that prevent current SDK controls from adopting updated shape and size.
3. Review controls for crowding after rebuilding with the latest SDK.
4. Use the extra-large control size when spacious, high-emphasis labeling benefits.
5. Use color in controls sparingly.
6. Tinted primary actions should remain legible in light, dark, and increased contrast.
7. Dense inspector UI on macOS can use smaller controls and rounded rectangles.
8. Touch-first UI should preserve comfortable hit targets and spacing.
9. Pointer and keyboard UI should preserve focus rings, hover states, menu access, and shortcuts.
10. Do not layer glass controls over busy content without separation.

## Lists, Tables, Forms, And Organization

1. List, table, and form rows may need more breathing room under the new design.
2. Use updated section corner radii and system grouped styles where possible.
3. Section headers should use title-style capitalization when matching the current system style.
4. Dense operational UI still needs scanability; do not turn every row into a large decorative card.
5. Use table/list selection states consistently across platforms.
6. Use disclosure, accessory, and status placement consistently across iPhone, iPad, and Mac variants.
7. Keep repeated content in stable dimensions to avoid layout shift.
8. Empty, loading, error, and permission-denied states must be designed, not improvised.

## Accessibility And Settings

1. Test light, dark, increased contrast, reduced transparency, and reduced motion.
2. Test Dynamic Type or platform text scaling.
3. Test keyboard navigation and visible focus.
4. Test VoiceOver labels for icon-only buttons and custom controls.
5. Test pointer hover and right-click/context menus on iPad and Mac.
6. Test touch target size on iPhone and iPad.
7. Avoid conveying state by color alone.
8. Keep material-backed text legible over realistic content, not blank mock backgrounds.
9. Prefer system colors and vibrant colors over fixed grays on material.
10. Custom animation must respect motion settings and must not be required for comprehension.

## Platform Notes

1. SwiftUI: prefer `NavigationStack`, `NavigationSplitView`, `toolbar`, `confirmationDialog`, standard controls, safe areas, and current material/glass APIs.
2. UIKit: prefer `UINavigationBar`, `UITabBar`, `UIToolbar`, `UISplitViewController`, standard controls, source views for presentations, and standard selectors.
3. AppKit: prefer `NSToolbar`, `NSSplitViewController`, standard controls, menus, title bar behavior, and macOS density conventions.
4. Catalyst: audit every toolbar, menu, split view, and modal because inherited defaults can reveal web-like or iOS-only assumptions.
5. iPadOS: support continuous window resizing, menu bar commands, pointer, keyboard, and fluid split-view layouts.
6. macOS: do not inflate all controls to touch scale. Preserve desktop density while adopting new materials and hierarchy.
7. watchOS: keep to standard button styles and toolbar APIs.
8. tvOS: use standard focus APIs so focus effects and Liquid Glass behavior align with the system.
9. visionOS: preserve depth hierarchy, focus clarity, and legibility; avoid decorative material overload.

## Cross-platform Review Checklist

Before calling Apple-platform UI work complete, verify:

1. Standard components were preferred over custom drawing.
2. Custom bars, tab bars, sidebars, and controls do not fight system material.
3. Liquid Glass is only in the functional layer or transient interactive controls.
4. Nested shapes are concentric or intentionally fixed.
5. Toolbar actions are grouped by function and frequency.
6. Primary actions are separate and obvious.
7. Tab bars contain persistent navigation, not contextual commands.
8. Action sheets/popovers originate from their source.
9. Scroll edge effects are used only where functional and not stacked.
10. Background extension keeps text and controls above distorted content.
11. Symbols are consistent across devices.
12. Ambiguous actions use text labels.
13. Shared component anatomy survives iPhone, iPad, and Mac layouts.
14. Window resizing keeps task continuity.
15. Light, dark, increased contrast, reduced transparency, and reduced motion were checked.
16. Keyboard, pointer, touch, and accessibility labels were checked.
17. No dense wall of decorative cards was introduced.
18. The UI feels like the current Apple platform, not a web app in a native shell.

---

# AppKit rules (WWDC25 session 310)

Source basis: Apple WWDC25 session 310, "Build an AppKit app with the new design", plus AppKit, Liquid Glass, and macOS HIG references.

## Adoption Pass

1. Rebuild with the current Xcode SDK before redesigning. Let AppKit show what updates automatically.
2. Audit from structural regions inward: window, toolbar, split view, sidebar, inspector, scroll views, accessory views, controls, menus, custom glass.
3. Remove custom chrome before adding new chrome.
4. Use AppKit controls and containers first; custom views should fill actual product gaps.
5. Validate in active and inactive window states, light and dark appearance, high contrast, reduced transparency, and reduced motion.

## Window And Toolbar Structure

1. Treat the toolbar as a floating functional region above content.
2. Let `NSToolbar` place items on adaptive glass by default.
3. Trust automatic toolbar grouping for multiple action buttons.
4. Use `NSToolbarItemGroup` when toolbar actions need explicit logical grouping.
5. Use spacers to separate unrelated toolbar groups.
6. Do not put noninteractive labels, titles, counters, or status indicators on glass as if they are buttons.
7. For noninteractive toolbar items, set the toolbar item to an unbordered presentation.
8. Use toolbar item prominence for important state or primary emphasis.
9. Use a toolbar item background tint only when color communicates meaningful state or priority.
10. Do not tint a group of unrelated toolbar actions.
11. Use `NSItemBadge` for unread, pending, new, or notification-like toolbar state.
12. Badges must communicate state, not decoration.
13. Check toolbar content against adaptive glass over bright and dark scrolled content.
14. Dark Mode support must flow through `NSAppearance`; do not special-case static toolbar colors.

## Split Views, Sidebars, And Inspectors

1. Use `NSSplitViewController` for split layouts so AppKit can supply current sidebar and inspector materials.
2. Use sidebar or inspector split-item behavior instead of hand-built panel chrome.
3. Sidebars float above adjacent content on glass.
4. Inspectors use edge-to-edge glass beside content.
5. Remove legacy sidebar `NSVisualEffectView` material; it blocks the new sidebar glass.
6. If content should flow beneath a floating sidebar, enable automatic safe-area adjustment on the content split item, not on the sidebar.
7. Use content under sidebars for maps, artwork, media, horizontal scrolling, swipe-reveal list rows, and other surfaces that benefit from edge-to-edge continuity.
8. Keep controls and text inside safe areas even when visual content extends beneath glass.
9. Do not obscure important artwork just to achieve the sidebar-underlay effect.
10. For edge-to-edge artwork without spare negative space, use background extension rather than covering the actual content.

## Background Extension

1. Use `NSBackgroundExtensionView` when content should visually extend under a titlebar, sidebar, or inspector without moving important content under those regions.
2. Assign the actual content as the background extension view's content view.
3. Let the view place content inside the safe area and generate edge extension outside it.
4. Use this for hero art, posters, photos, maps, media, and rich visual backgrounds.
5. Do not use it for text-heavy or control-heavy surfaces where replicated/blurred edges reduce clarity.

## Window Corners And Layout Regions

1. New macOS window corners are softer and larger, especially with toolbars.
2. Content close to window corners can clip or feel crowded.
3. Use `NSView.LayoutRegion` and corner adaptation when controls need to sit near a rounded window corner.
4. Prefer layout-region guides over hardcoded corner padding.
5. Use horizontal or vertical corner adaptation based on which edge the content approaches.
6. Keep corner avoidance inside Auto Layout constraints so resizing remains correct.
7. Titlebar-only windows and toolbar windows can have different corner geometry; do not assume one radius.

## Scroll Edge Effect (AppKit)

1. The scroll edge effect separates floating glass from edge-to-edge content.
2. In AppKit, let `NSScrollView` host the effect for scrollable content.
3. The effect can adapt as floating regions appear, disappear, or change size.
4. Use titlebar accessories and split item accessories for floating content that should participate in the scroll edge effect.
5. Use `NSSplitViewItemAccessoryViewController` for accessories that belong to a single split pane.
6. Add top-aligned or bottom-aligned split item accessories through the split view item APIs.
7. Do not fake scroll edge effects with manual overlays.
8. Do not place floating accessory controls outside the mechanisms that update safe areas and edge effects.
9. Prefer accessory APIs because they influence both the visual edge and the content safe area.

## Controls (AppKit APIs)

1. AppKit control metrics changed. Audit any old fixed heights.
2. Use Auto Layout instead of hardcoded control heights.
3. Mini, small, and medium controls remain desktop-density controls but now have more breathing room.
4. Large and extra-large controls express higher emphasis and use rounder capsule-like shapes.
5. Use extra-large controls only for primary actions people launch the app to perform.
6. For dense inspectors and popovers that genuinely need previous sizing, set `prefersCompactControlSizeMetrics` on the relevant container view.
7. Do not set compact metrics globally just to avoid layout work.
8. Use `borderShape` to align buttons, popup buttons, and segmented controls with a custom container's shape.
9. Use capsule shapes for medium controls inside capsule containers when concentricity would otherwise break.
10. Use glass bezel style only for buttons that need to float above content.
11. Use bezel color or tint only when it improves meaning, state, or action recognition.
12. Use tint prominence to control how much visual weight a color receives.
13. For destructive buttons, prefer lower prominence red tint when a warning cue is needed without overpowering a nearby primary/default action.
14. Make the default action respond to Return with a key equivalent where appropriate.
15. Let default-button status drive primary prominence instead of manually over-tinting.
16. Use slider tint prominence to choose whether the filled track is meaningful.
17. Use slider `neutralValue` when the visual fill should communicate deviation from a baseline, such as playback speed around 1x.

## Menus (AppKit)

1. Add clear, recognizable symbols to important menu actions.
2. Menu icons should form a scan-friendly column within sections.
3. Use symbols for recognition, not decoration.
4. Avoid near-duplicate symbols in closely related actions.
5. Text remains the precise command name; iconography supports scanning.
6. Keep menu bar menus and context menus consistent in action naming and symbol choices.
7. Prefer standard menu commands and selectors so the system can apply current platform behavior.

## Custom Liquid Glass (AppKit)

1. Before adding custom glass, ask whether the element is top-level functionality floating over content.
2. Use custom glass sparingly for important controls and navigation, not content cards.
3. Use `NSGlassEffectView` to put specific content on glass.
4. Set the glass effect view's `contentView`; do not put glass behind content as a sibling.
5. Let AppKit apply legibility treatments through the glass content relationship.
6. Customize corner radius only to maintain shape harmony.
7. Customize tint only when it supports state, brand, or action hierarchy without hurting legibility.
8. If several glass views are close together or form a logical group, wrap them in `NSGlassEffectContainerView`.
9. Use `NSGlassEffectContainerView.spacing` to control when grouped glass elements visually merge.
10. Grouping glass views improves visual correctness because glass sampling is shared.
11. Grouping glass views improves performance by reducing repeated sampling passes.
12. Do not allow one glass view to sample another glass view through overlap or proximity outside a container.
13. Profile custom glass in realistic windows over real content.

## Mac Experience Rules

1. Mac apps should use large displays to reduce unnecessary nesting and modality.
2. Preserve comfortable information density; do not inflate the app into touch-only spacing.
3. Support resizable, hideable, showable, movable windows and full-screen mode when appropriate.
4. Use the menu bar for complete command access.
5. Support keyboard shortcuts for frequent actions.
6. Support high-precision pointer workflows.
7. Support toolbar customization or view configuration where it fits the app's purpose.
8. Keep inactive-window behavior polished.
9. Do not ship an iOS layout in a Mac window.

## AppKit Review Checklist

Before calling AppKit new-design work complete, verify:

1. Built with the current SDK.
2. Toolbar items group correctly.
3. Noninteractive toolbar items are not bordered/glass-backed like buttons.
4. Important toolbar actions use prominence or badges only with meaning.
5. Split views use `NSSplitViewController` and correct sidebar/inspector behavior.
6. Legacy sidebar material was removed.
7. Content that extends beneath sidebars uses safe-area adjustment correctly.
8. Rich edge-to-edge visuals use `NSBackgroundExtensionView` where appropriate.
9. Corner-adjacent controls use layout regions instead of magic padding.
10. Scroll edge effects come from scroll/accessory APIs, not overlays.
11. Control heights are not hardcoded.
12. Compact metrics are limited to genuinely dense legacy regions.
13. Border shapes preserve concentricity.
14. Default buttons have correct keyboard behavior.
15. Sliders with baselines use neutral values.
16. Menus include helpful symbols.
17. Custom glass uses `contentView`, not sibling backgrounds.
18. Nearby glass elements are grouped in a glass effect container.
19. The window resizes cleanly.
20. Light/dark, contrast, reduced transparency, reduced motion, keyboard, pointer, and accessibility states were checked.
