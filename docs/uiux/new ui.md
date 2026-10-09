# UI Redesign — Workflow Editor

## 1. Main Goal

Before starting the development of new Nodes, I realized that the current UI is not suitable for a long-term, creative workspace.

The problem is not a lack of functionality. The problem is that too much information and too many controls are displayed simultaneously. This creates unnecessary visual noise, increases cognitive load, and makes the workspace tiring to use.

Based on my experience with tools like n8n, I want to redesign the UI around one main principle:

**The Editor should be a clean, focused workspace where the user can comfortably build Workflows and establish relationships between Nodes.**

The reference image I provided should guide the overall design direction, taking inspiration from Enlighten's visual simplicity while maintaining the project's own identity.

The goal is not to preserve every existing UI element. Remove unnecessary panels, decorative controls, and redundant functionality. Keep essential features accessible without allowing them to clutter the Editor.

## 2. Language Support

The application must use English exclusively.

* Remove Persian language support completely.
* Remove Persian translations and related language-switching options.
* Keep all interface labels, menus, messages, and settings in English.
* Do not spend time maintaining or redesigning the Persian localization.

## 3. Top Bar

Redesign the top bar according to the provided reference image. It should have three main sections.

### Left Section

Include:

* Hamburger menu: Opens access to the current Workflow's workspace and files.
* Extract button.
* Save button.

Keep these controls compact and visually consistent with the reference.

### Center Section

This section contains the application's main tabs.

Required tabs:

* Editor
* Extraction
* Executions

The Editor must remain focused on building Workflows. Features that are not directly necessary for editing should live in their appropriate sections rather than adding clutter to the Editor.

The tab structure should remain extensible so additional sections can be added later when genuinely necessary.

### Right Section

Include only:

* Project name.
* Project logo.

Do not add unnecessary controls to this section.

## 4. Left Vertical Sidebar

Redesign the left sidebar as a minimal navigation bar containing only the following items, in this order from top to bottom:

1. **New Workflow (+):** Creates a new Workflow.
2. **Home / Dashboard:** Opens the main dashboard.
3. **Workspace:** Opens the Workflow workspace.
4. **Executions:** Provides access to Workflow execution history and execution details.
5. **Settings:** Opens application settings and stays at the bottom of the sidebar.

Use the existing appropriate icons where possible. Avoid adding unnecessary navigation items.

### New Workflow Behavior

Creating a Workflow must immediately create and persist a real Workflow, even when the user has not added any Nodes.

Expected behavior:

* Clicking the + button creates a new Workflow.
* A valid Workflow ID is assigned immediately.
* The initial Workflow metadata is saved.
* Its dedicated file workspace is created or initialized.
* The empty Workflow appears in the Workspace list.
* The Workflow remains available after navigating away from the Editor or refreshing the application.

Workflow creation must not depend on adding the first Node or manually saving the Workflow.

### Workflow ID and File Workspace

Each Workflow must have its own unique Workflow ID and dedicated file workspace.

The file workspace must be accessible as soon as the Workflow is created, even when the Workflow contains no Nodes.

For example, if the user creates a Workflow and immediately opens the hamburger menu to access its files, the workspace must already exist and be accessible.

Do not defer Workflow ID creation or workspace initialization until the first Node is added.

Preserve the existing storage architecture and ensure that each Workflow's files remain isolated from other Workflows.

## 5. Adding Nodes

The + button in the upper area of the Editor must open the existing Node selection interface.

This should behave like the current double-click interaction on an empty area of the Editor.

Expected behavior:

* Clicking + opens the Node selection menu.
* The menu appears centered in the viewport, not attached to a corner or sidebar.
* Increase its size slightly compared with the current implementation to make Node selection more comfortable.
* Preserve the existing Node selection functionality.

This feature already exists, so reuse the existing implementation wherever possible rather than creating a redundant mechanism.

## 6. Execute Workflow

Rename the existing **Test Workflow** button to **Execute Workflow**.

Keep the button positioned at the bottom center of the Editor.

Preserve the existing execution functionality, while implementing the appropriate Live Browser behavior described below.

The button must trigger the test execution flow, including opening the live browser view when applicable.

## 7. Executions and Execution Details

The application must have one unified **Executions** section for execution history, execution details, and related Activity Logs.

Do not create a separate Activity Logs tab.

The purpose of this section is to allow users to inspect previous Workflow executions and understand exactly what happened during each run.

### Executions List

The main Executions view should display a structured list of Workflow runs.

Where supported by the existing execution data, display:

* Execution ID.
* Workflow name.
* Execution status.
* Start time.
* Duration.
* Relevant error information.

Make it easy to distinguish successful, failed, and currently running executions.

The interface should remain compact and readable, without unnecessary visual elements.

### Execution Details

When the user selects an execution, open its details view.

This view should provide the information necessary to understand and troubleshoot that specific run, including:

* Overall execution status.
* Execution duration and relevant timing information.
* The sequence of execution events.
* Node execution statuses.
* Node inputs and outputs, where available.
* Error messages and relevant debugging information.
* Activity Logs associated with that execution.

### Activity Logs Within Execution Details

Activity Logs must be integrated into the selected execution's details.

They should display relevant events in chronological order, making it easy to understand how the execution progressed.

Improve the existing log interface so that:

* Events are clearly organized and easy to scan.
* Timestamps and event descriptions are readable.
* Errors and warnings are visually distinguishable from normal events.
* Node-related events can be identified easily.
* Detailed information does not overwhelm the interface.
* The user can quickly identify where and why an execution failed.

The exact presentation may use a timeline, structured event list, or another layout that fits the existing architecture.

**Important:** Reuse and reorganize the existing Activity Logs functionality wherever possible. Do not duplicate execution logging or create a second logging system unnecessarily.

### Node-Level Details

When the existing architecture supports it, users should be able to inspect an individual Node's execution information, including its input, output, status, and errors.

Keep these details within the selected execution's context rather than creating another permanent navigation section.

### Scope of Activity Logs

For this version, Activity Logs should focus on events associated with a specific Workflow execution.

Do not create a separate global Activity Logs section unless the existing application already has a distinct need for system-wide events that cannot be represented within execution details.

### Remove the Separate Activity Logs Tab

The previous design proposal included an independent Activity Logs tab. That is no longer required.

The final structure must be:

* **Editor:** Build and edit Workflows.
* **Extraction:** Access the existing extraction functionality.
* **Executions:** Browse execution history, inspect execution details, and view related Activity Logs.

Do not add a fourth tab for Activity Logs.

## 8. Bottom-Left Toolbar and Minimap

Preserve the compact toolbar located at the bottom-left of the Editor.

It includes the existing navigation controls, such as:

* Mouse Pointer.
* Hand / Pan.
* Zoom In.
* Zoom Out.

Keep these controls accessible without allowing them to dominate the interface.

### Minimap Behavior

The Minimap should remain available but visually unobtrusive.

Expected behavior:

* When the Mouse Pointer tool is selected, the Minimap remains at low opacity.
* When the Hand / Pan tool is selected, the Minimap also remains at low opacity.
* When the user changes the Canvas position or visible viewport, the Minimap becomes temporarily more visible.
* Keep the Minimap more visible for approximately four to five seconds after the last relevant viewport change.
* If no further changes occur, return it to its low-opacity state.
* Hovering over the Minimap should make it sufficiently visible for comfortable interaction.

The goal is to keep the Minimap functional without constantly drawing attention away from the Nodes.

Implement this using the existing Canvas and Minimap behavior wherever possible.

## 9. Live Browser Behavior

The Live Browser must behave differently depending on whether the user is testing a Workflow or running it in Active mode.

### Test Mode — Execute Workflow

When the user clicks Execute Workflow, open a new browser tab in the user's main browser to display the Remote Browser view.

The user should be able to observe the Automation in real time, including:

* Browser startup and page navigation.
* Page loading.
* Clicking elements.
* Hovering over elements.
* Typing text.
* Other actions performed by the Workflow.

The Live Browser view must be **read-only from the user's perspective**.

The user must not be able to interact directly with the displayed website in a way that interferes with the Automation.

Specifically:

* Mouse clicks must not trigger website interactions.
* Keyboard input must not be sent to the page.
* Manual interactions must not interfere with the running Workflow.

The purpose is to observe the Automation without mixing manual interaction with automated execution.

Preserve the underlying browser automation functionality. Implement the read-only behavior at the appropriate interaction layer rather than breaking the browser session itself.

### Active Mode — Background Execution

When a Workflow is activated for ongoing or background execution, opening a visible Live Browser tab should no longer be necessary.

Expected behavior:

* The Automation runs in the background.
* No new visible browser tab is opened for observation.
* The browser operates in the appropriate hidden execution mode.
* System resource usage, particularly RAM, is kept as low as practical.

Use the project's existing hidden-browser or headless execution mechanism, whichever is compatible with its architecture.

Do not assume that headless mode is interchangeable with every existing hidden-browser implementation. Inspect the current browser lifecycle and preserve any requirements associated with persistent contexts, browser profiles, or extensions.

### Execution Mode Summary

* **Test:** Run the Workflow and open a read-only Live Browser view for real-time observation.
* **Active:** Run the Workflow in the background without opening a visible observation tab.

The distinction must be implemented without compromising Automation reliability or creating unnecessary browser instances.

## 10. General Design and Implementation Principles

Follow these principles throughout the redesign.

### Visual Design

* Prioritize simplicity and visual clarity.
* Keep the Editor focused on Nodes and their relationships.
* Use the provided reference image as the main design direction.
* Avoid unnecessary borders, panels, labels, and decorative elements.
* Preserve a consistent visual hierarchy across all tabs.
* Keep secondary functionality accessible without making it permanently visible.

### Functional Integrity

* Preserve existing functionality unless a specific change is described above.
* Reuse existing components and logic wherever possible.
* Avoid duplicate features, redundant controls, and parallel implementations of existing systems.
* Do not remove useful execution data when reorganizing Activity Logs.
* Ensure that navigation and execution details work consistently across the application.

### Workflow Persistence

* Create and persist a Workflow immediately when the user clicks New Workflow.
* Assign its Workflow ID immediately.
* Initialize its dedicated file workspace without waiting for the first Node.
* Ensure that empty Workflows remain visible in the Workspace list.

### Implementation Approach

Before making changes, inspect the existing project structure and identify the current implementations of:

* Top bar and tab navigation.
* Left sidebar.
* Workflow creation and persistence.
* Workflow ID generation.
* Per-Workflow file workspace.
* Node selection.
* Executions and execution history.
* Activity Logs and execution details.
* Canvas toolbar and Minimap.
* Live Browser and browser execution modes.

Implement the redesign through focused changes that fit the current architecture.

Do not rewrite working subsystems unnecessarily. Do not introduce duplicate navigation, execution logging, or browser lifecycle management.

After implementation, verify the relevant flows and run the existing tests and checks. Fix regressions introduced by the changes.

## Final Expected Result

The final UI should be a clean, comfortable, and extensible Workflow workspace centered on Node creation and visual connections.

It should include:

* A minimal top bar and left navigation sidebar.
* English-only interface.
* Immediate Workflow persistence and dedicated file workspaces.
* A clean Editor with accessible Node selection.
* Separate Editor, Extraction, and Executions sections.
* Execution history and detailed execution inspection in one unified section.
* Activity Logs integrated into execution details rather than displayed as a separate tab.
* A subtle, functional Minimap.
* Read-only Live Browser observation during testing.
* Hidden background browser execution in Active mode.

The priority is not to display more information. It is to present the right information in the right place, with minimal visual noise and without sacrificing existing functionality.
