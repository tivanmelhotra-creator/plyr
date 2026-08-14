# Element Inspector — Final Implementation Specification

Implement the Element Inspector as a Chrome/Chromium Extension whose only purpose is to inspect a DOM element in the user's browser and send ONE selected attribute/value to ONE exact Workflow Node Field.

The implementation must follow the architecture, security model, target identity, inspection behavior, dynamic attribute discovery, and UI behavior defined below.

---

# 1. CORE ARCHITECTURE

The browser is ALWAYS the user's own local Chrome/Chromium browser.

There is NO concept of:

- Remote Browser
- Local Browser vs Remote Browser
- Browser Session
- Remote Browser Session
- Browser Migration
- Browser Profile Transfer
- Browser Tab Synchronization

The only Local/Remote distinction is the LOCATION OF THE BACKEND.

### LOCAL BACKEND

```text
http://127.0.0.1:3000
```

### REMOTE BACKEND

```text
https://server.example.com
```

Therefore the architecture is:

```text
USER'S CHROME / CHROMIUM
            │
            ▼
ELEMENT INSPECTOR EXTENSION
            │
      ┌─────┴─────┐
      │           │
      ▼           ▼
LOCAL BACKEND   REMOTE BACKEND
127.0.0.1:3000  server.example.com
      │           │
      └─────┬─────┘
            ▼
      AUTHORIZATION
            │
            ▼
    EXACT TARGET FIELD
            │
            ▼
      NODE / FIELD
            │
            ▼
 AUTOMATION WORKFLOW
```

The extension's only job is:

```text
INSPECT ELEMENT
→ DISCOVER REAL ELEMENT DATA
→ SELECT WHAT TO DISPLAY
→ SELECT ONE VALUE TO SEND
→ SEND
→ EXACT NODE FIELD
```

---

# 2. TARGET FIELD IS THE CORE IDENTITY

Every Node must have a stable Node ID.

Every Node Field must have a stable Field identity.

The Target Field ID must contain:

1. Node ID
2. Human-readable Field Key
3. Unique stable suffix

### Required format

```text
node_<nodeId>__<fieldKey>__<uniqueSuffix>
```

Example:

```text
Node ID:
node_8f21

Field Title:
Product Selector

Field Key:
product_selector

Unique suffix:
a73f
```

Final Target Field ID:

```text
node_8f21__product_selector__a73f
```

### IMPORTANT

Do NOT use:

```text
node_8f21.selector
```

Do NOT use only:

```text
node_8f21
```

Do NOT use a completely opaque identifier with no human-readable Field Key.

The human-readable Field Key is part of the technical Field ID.

This gives the user immediate visual confirmation that the target appears to be the Field they intended.

---

# 3. FIELD ID SEMANTICS

The complete Target Field ID is the exact technical identity.

Example:

```text
Field Title:
Product Selector

Field Key:
product_selector

Target Field ID:
node_8f21__product_selector__a73f
```

The Field Key should normally be derived from the Field Title at Field creation time.

Example:

```text
Product Selector
↓
product_selector
```

Use a stable normalization rule for the Field Key.

The unique suffix prevents collisions.

### IMPORTANT STABILITY RULE

The Backend must treat the COMPLETE Target Field ID as the identity.

Do NOT resolve the target by:

- Field Title
- Field Key
- Node name
- Node position
- UI position
- tab
- browser URL
- browser session
- browser tab
- guessing

The exact target is:

```text
targetFieldId
```

If the visible Field Title changes later, do not silently calculate a new target identity from the changed title.

The established Target Field ID should remain stable unless the product explicitly recreates the Field as a new Field.

---

# 4. TARGET DISPLAY IN THE EXTENSION

The Target Field must be visible in the Inspect UI.

Example:

```text
TARGET FIELD

Node
Product Extraction

Field
Product Selector

Field ID
node_8f21__product_selector__a73f

● Connected to this Field
```

The human-readable Node and Field names must have stronger visual hierarchy.

The technical Field ID must be clearly visible but visually secondary.

The purpose of this UI is to make the user completely confident that the result will go to exactly:

```text
Product Extraction
→ Product Selector
→ node_8f21__product_selector__a73f
```

---

# 5. LOCAL BACKEND CONNECTION

Default connection mode:

```text
LOCAL
```

Default Base URL:

```text
http://127.0.0.1:3000
```

The Extension connects to the local Backend running on the user's machine.

The Backend provides the authorized Target Field context after the user starts inspection from a Node Field in the Automation Editor.

The Extension must display:

```text
Node
Product Extraction

Field
Product Selector

Field ID
node_8f21__product_selector__a73f

Connection
● Connected
```

---

# 6. REMOTE BACKEND CONNECTION

REMOTE does NOT mean Remote Browser.

REMOTE means only:

The user's local Chrome/Chromium Extension connects to a Backend running on another server.

Example:

```text
https://server.example.com
```

The user provides:

1. Backend URL
2. API Key
3. Authorization Code

There is NO:

- login page
- username
- user ID
- remote browser
- browser session
- browser host
- profile selection

Do not introduce authentication fields that are not part of this architecture.

---

# 7. AUTHORIZATION CODE

The Authorization Code is temporary.

The Backend generates an Authorization Code bound to:

- targetFieldId
- workflow
- project/context if applicable
- expiration time
- one Inspector connection/task

Example:

```text
ABCD-8F21
```

The Extension provides:

```json
{
  "baseUrl": "https://server.example.com",
  "apiKey": "...",
  "authorizationCode": "ABCD-8F21"
}
```

The Backend validates the Authorization Code.

If valid, the Backend returns the authorized target.

Example:

```json
{
  "targetFieldId": "node_8f21__product_selector__a73f",
  "nodeName": "Product Extraction",
  "fieldName": "Product Selector",
  "fieldKey": "product_selector",
  "status": "connected"
}
```

The Extension displays:

```text
CONNECTED TO TARGET

Product Extraction
Product Selector

node_8f21__product_selector__a73f

● Connection active
```

---

# 8. DO NOT TRUST THE CLIENT

The Extension must NEVER be able to choose an arbitrary Target Field.

For example, the client must not be able to submit:

```text
targetFieldId = "some-other-field"
```

and expect the server to accept it.

The Backend must determine the authorized Target Field from the Authorization Code / authorization context.

The Authorization Code must be:

- short-lived
- scoped to the intended Target Field
- validated server-side
- invalidated after successful completion or expiration

The server must reject:

- unauthorized targets
- expired authorization
- invalid authorization
- target mismatch
- malformed authorization context

Never silently redirect the data to another Node Field.

---

# 9. INSPECTOR FLOW

The intended flow is:

1. User opens a Node Field in the Automation Editor.
2. User clicks the Element Inspector / Target icon.
3. Backend creates an Inspector authorization context for the exact Target Field.
4. User opens the Chrome/Chromium Extension.
5. Extension connects to the selected Backend.
6. Backend validates the authorization context.
7. Extension receives the authorized Target Field.
8. Extension displays Node, Field, and Target Field ID.
9. User activates Inspect mode.
10. User hovers over an element.
11. Element is highlighted.
12. User clicks the element.
13. Extension inspects the actual selected DOM element.
14. Extension discovers the actual properties and attributes of that element.
15. Extension dynamically builds the Attributes list from what actually exists on that element.
16. User chooses CHECKBOXES for the properties that should appear in SELECTED ELEMENT.
17. User chooses exactly ONE RADIO option for the value that should be sent.
18. Extension displays the chosen outbound value in Destination.
19. User clicks Send Selected Attribute.
20. Extension sends only the Radio-selected value.
21. Backend resolves the authorized Target Field.
22. Backend updates exactly that Node Field.
23. Backend returns confirmation.
24. Extension shows success feedback.

---

# 10. ELEMENT INSPECTION DATA MODEL

When an element is selected, the Inspector must collect two types of information:

## A. DERIVED INSPECTOR PROPERTIES

These are generated by the Inspector itself.

At minimum:

- tagName
- text
- cssSelector
- xpath

These are not necessarily literal HTML attributes.

Example:

```text
Tag Name
div

Text
Nike Air Max

CSS Selector
div.product-card[data-order="123"]

XPath
//div[@data-order="123"]
```

## B. ACTUAL DOM ATTRIBUTES

These are the attributes that actually exist on the selected DOM element.

Examples:

- id
- class
- style
- title
- data-*
- aria-*
- href
- src
- alt
- role
- type
- name
- value
- placeholder
- required
- disabled
- custom attributes
- unknown attributes

But ONLY when they actually exist on the selected element.

---

# 11. CRITICAL REQUIREMENT — DYNAMIC ATTRIBUTE DISCOVERY

The Attributes panel MUST be dynamically generated from the ACTUAL selected DOM element.

Do NOT render a static list of generic HTML attributes for every element.

Do NOT assume that every element contains common attributes.

The system must inspect the selected element and discover what actually exists.

### Example

Suppose the selected element is:

```html
<div
  class="product-card"
  data-order="123"
  data-product-id="987"
  data-sku="NK-001"
  aria-label="Nike Air Max"
>
```

The Inspector must dynamically discover:

```text
class
data-order
data-product-id
data-sku
aria-label
```

plus derived Inspector properties such as:

```text
Tag Name
Text
CSS Selector
XPath
```

Therefore the Attributes list may look like:

```text
☑ ○ Tag Name
☑ ○ Text
☑ ○ Class
☑ ○ data-order
☑ ○ data-product-id
☑ ○ data-sku
☑ ○ aria-label
☑ ○ CSS Selector
☑ ○ XPath
```

It MUST NOT automatically add:

```text
href
src
alt
target
data-id
placeholder
method
name
value
```

unless they actually exist on the selected element.

---

# 12. SUPPORTED ATTRIBUTE TYPES VS DISCOVERED ATTRIBUTES

This distinction is mandatory.

### Supported Attribute Types

These describe what the Inspector is capable of understanding.

Examples:

- id
- class
- href
- src
- alt
- data-*
- aria-*
- role
- type
- name
- value
- placeholder
- etc.

### Discovered Attributes

These are the actual attributes present on the currently selected DOM element.

Example:

```text
Selected Element A
→ data-order
→ data-product-id
→ data-sku
```

Another element may have:

```text
Selected Element B
→ data-id
→ data-price
→ tracking-id
→ custom-state
```

Another may have:

```text
Selected Element C
→ href
→ target
→ rel
```

The UI must reflect the actual selected element.

The Supported Attribute list must NEVER be rendered as a fixed checklist.

---

# 13. ARBITRARY / UNKNOWN ATTRIBUTES

If an element has custom or unknown attributes, they MUST remain inspectable.

For example, if an element contains:

```html
data-order="123"
data-product-id="987"
tracking-id="abc123"
product-state="active"
custom-price="49.99"
```

the Inspector must discover and display:

```text
data-order
data-product-id
tracking-id
product-state
custom-price
```

even if these names were never explicitly listed in the product specification.

The Inspector must work from the actual DOM.

Never discard an existing attribute just because it is not in a predefined allow-list.

---

# 14. MISSING ATTRIBUTES MUST NOT BE DISPLAYED

Do NOT show placeholder rows such as:

```text
href —
src —
alt —
data-id —
placeholder —
method —
```

when those attributes do not exist.

Missing attributes must simply not appear in the dynamically discovered list.

The Attributes panel should look like a real browser DOM inspector, not a checklist of all possible HTML attributes.

---

# 15. ATTRIBUTE SUPPORT

The Inspector should support at least the following categories when those attributes actually exist.

### Core / Derived

- tagName
- text
- CSS Selector
- XPath

### Global

- id
- class
- style
- title
- data-*
- dir
- lang
- hidden
- tabindex
- contenteditable
- autofocus
- role

### ARIA

- aria-label
- aria-labelledby
- aria-describedby
- aria-hidden
- aria-role
- any other existing aria-* attribute

### Links / Media

- href
- target
- src
- alt
- width
- height
- autoplay
- controls
- loop

### Forms

- type
- name
- value
- placeholder
- required
- disabled
- readonly
- maxlength
- min
- max
- action
- method

### Tables / Lists

- colspan
- rowspan
- reversed
- start

These are supported types, NOT a static visible list.

Only actual attributes found on the selected element should be displayed.

---

# 16. CHECKBOX VS RADIO — CORE UX RULE

Each discovered property/attribute must have two controls:

```text
[ Checkbox ] [ Radio ]
```

These controls have completely different purposes.

## Checkbox

Checkbox controls whether that property appears in:

```text
SELECTED ELEMENT
```

The user may select multiple Checkboxes.

Example:

```text
☑ ID
☑ Class
☑ CSS Selector
☑ XPath
```

All checked values become visible in SELECTED ELEMENT.

## Radio

Radio controls which ONE value is sent to the Target Field.

Exactly ONE Radio may be selected.

Example:

```text
☑ ○ ID
☑ ○ Class
☑ ● CSS Selector
☑ ○ XPath
```

This means:

- ID is displayed
- Class is displayed
- CSS Selector is displayed
- XPath is displayed

but ONLY:

```text
CSS Selector
```

is sent.

The checkbox and radio states must remain independent.

---

# 17. SELECTED ELEMENT

The SELECTED ELEMENT section must dynamically reflect the Checkbox state.

It must NOT show every property automatically.

Example selected element:

```html
<div
  class="product-card"
  data-order="123"
  aria-label="Nike Air Max"
>
```

If the user has checked:

```text
Tag Name
Class
data-order
```

then SELECTED ELEMENT shows:

```text
SELECTED ELEMENT

Tag
<div>

Class
product-card

data-order
123
```

If the user then checks `aria-label`, it appears.

If the user unchecks `Class`, it disappears.

This must happen dynamically.

---

# 18. ATTRIBUTES PANEL

The Attributes panel should look similar to a modern browser inspector.

Each row:

```text
[Checkbox] [Radio] Attribute Name     Value
```

Example:

```text
☑ ○ Tag Name           div
☑ ○ Text               Nike Air Max
☑ ○ Class              product-card
☑ ○ data-order         123
☑ ● CSS Selector       div.product-card[data-order="123"]
☑ ○ XPath              //div[@data-order="123"]
☐ ○ aria-label         Nike Air Max
```

The actual rows depend entirely on the currently selected element.

Do not show arbitrary unsupported placeholders.

---

# 19. SELECT ALL / CLEAR

Provide:

```text
[ Select All ]
[ Clear ]
```

These controls affect CHECKBOXES only.

They must NOT modify the Radio selection.

### Select All

Checks every currently discovered/displayable property.

### Clear

Unchecks all properties.

Radio selection remains independent.

---

# 20. DESTINATION

Below Attributes, show a Destination section.

Example:

```text
DESTINATION

Node
Product Extraction

Field
Product Selector

Field ID
node_8f21__product_selector__a73f

Selected value
CSS Selector

Value
div.product-card[data-order="123"]

● Connected to this Field
```

The user must clearly understand:

```text
Selected Element
↓
Selected outbound attribute
↓
Exact authorized Target Field
```

---

# 21. SEND ACTION

Primary action:

```text
[ Send Selected Attribute ]
```

Do NOT use:

```text
Send Selected Attributes
```

because the system sends exactly ONE Radio-selected value.

The actual outbound request should contain the selected attribute/value.

Example:

```json
{
  "attribute": "cssSelector",
  "value": "div.product-card[data-order=\"123\"]"
}
```

The exact Target Field is resolved by the Backend's authorization context.

The client must not redefine the target.

---

# 22. SEND VALIDATION

Before sending, the extension must verify:

1. Inspector is connected.
2. Authorization is still valid.
3. Target Field is still authorized.
4. A valid element is selected.
5. A Radio option is selected.
6. The Radio-selected property has a valid value.
7. The value can be serialized correctly.

If no Radio option is selected, disable the Send button or show a clear validation message.

Example:

```text
Select one attribute to send.
```

---

# 23. ELEMENT PAYLOAD

Example internal request:

```json
{
  "element": {
    "tagName": "div",
    "text": "Nike Air Max",
    "attributes": {
      "class": "product-card",
      "data-order": "123",
      "data-product-id": "987",
      "aria-label": "Nike Air Max"
    },
    "cssSelector": "div.product-card[data-order=\"123\"]",
    "xpath": "//div[@data-order=\"123\"]"
  },
  "displayAttributes": [
    "tagName",
    "class",
    "data-order",
    "data-product-id",
    "aria-label",
    "cssSelector",
    "xpath"
  ],
  "sendAttribute": {
    "name": "cssSelector",
    "value": "div.product-card[data-order=\"123\"]"
  }
}
```

`displayAttributes` is driven by CHECKBOX selections.

`sendAttribute` is driven by the single RADIO selection.

The Backend already knows the authorized Target Field.

---

# 24. SUCCESS RESPONSE

After successful send, Backend returns:

```json
{
  "success": true,
  "targetFieldId": "node_8f21__product_selector__a73f",
  "nodeName": "Product Extraction",
  "fieldName": "Product Selector",
  "attribute": "cssSelector",
  "value": "div.product-card[data-order=\"123\"]"
}
```

Extension displays:

```text
✓ Sent successfully

Product Selector

node_8f21__product_selector__a73f

CSS Selector

div.product-card[data-order="123"]
```

---

# 25. CONNECTION TAB

The Extension has exactly two tabs:

```text
INSPECT
CONNECTION
```

The Connection tab contains ONLY Backend connection and authorization settings.

### Connection Mode

```text
● LOCAL
Backend on this computer

○ REMOTE
Backend on remote server
```

### LOCAL

```text
Base URL

http://127.0.0.1:3000
```

### REMOTE

```text
Base URL

https://your-server.com
```

### Authentication

```text
API KEY
[ ••••••••••••• ]

AUTHORIZATION CODE
[ ABCD-8F21 ]
```

Primary action:

```text
[ Connect ]
```

There is NO:

- username
- user ID
- password
- login form

Authentication consists only of:

```text
Backend URL
+
API Key
+
Authorization Code
```

---

# 26. CONNECTED CONNECTION STATE

After successful connection:

```text
● Connected

Backend
https://example.com

Authorization
Valid
```

Then:

```text
CONNECTED TO TARGET

Product Extraction

Product Selector

Field ID

node_8f21__product_selector__a73f

● Connection active
```

The target confirmation is essential.

---

# 27. ERROR HANDLING

Handle at minimum:

```text
BACKEND_UNREACHABLE
INVALID_API_KEY
INVALID_AUTHORIZATION_CODE
AUTHORIZATION_EXPIRED
TARGET_FIELD_NOT_FOUND
TARGET_NOT_AUTHORIZED
INSPECTOR_DISCONNECTED
ELEMENT_INSPECTION_FAILED
ATTRIBUTE_SEND_FAILED
```

Each error must have a clear user-facing message.

Examples:

```text
Backend unreachable
Check the Backend URL.

Invalid API Key
Check the API Key and reconnect.

Authorization code invalid
Request a new Authorization Code.

Authorization code expired
Start a new Inspector authorization.

Target Field unavailable
The authorized Field no longer exists.

Target not authorized
This Inspector is not authorized for the requested Field.

Inspector disconnected
Reconnect the Extension.

Unable to inspect element
Try selecting the element again.

Unable to send attribute
Retry the send operation.
```

Possible actions:

```text
[ Retry ]
[ Reconnect ]
[ New Authorization Code ]
```

Do not silently redirect to another Field.

---

# 28. WHAT IS NOT PART OF THIS FEATURE

Do NOT implement:

- Remote Browser
- Browser Session migration
- Browser Tab synchronization
- Cookie synchronization
- Browser profile transfer
- Active tab transfer
- Browser state transfer
- User login
- User ID
- Username
- permanent session management
- browser session selection
- manual Target Field ID entry
- Target Field dropdown
- Node dropdown
- Field dropdown

The user does NOT select a target manually inside the extension.

The Backend authorization context provides it.

---

# 29. FINAL ARCHITECTURE

```text
                    USER CHROME
                         │
                         ▼
              ELEMENT INSPECTOR
                  EXTENSION
                         │
                 ┌───────┴───────┐
                 │               │
                 ▼               ▼
           LOCAL BACKEND    REMOTE BACKEND
          127.0.0.1:3000     Server URL
                 │               │
                 └───────┬───────┘
                         ▼
                    AUTHORIZATION
                         │
                         ▼
               EXACT TARGET FIELD
                         │
                         ▼
     node_8f21__product_selector__a73f
                         │
                         ▼
                    NODE / FIELD
                         │
                         ▼
              AUTOMATION WORKFLOW
```

CORE RULE:

The browser is not the target.

The browser session is not the target.

The URL is not the target.

The Backend location is not the target.

The target is:

```text
TARGET FIELD ID
```

with the format:

```text
node_<nodeId>__<fieldKey>__<uniqueSuffix>
```

The final Inspector behavior is:

```text
INSPECT ELEMENT
        ↓
DISCOVER ACTUAL DOM PROPERTIES
        ↓
DISPLAY ONLY REAL ATTRIBUTES OF THIS ELEMENT
        ↓
CHECKBOX = WHAT APPEARS IN SELECTED ELEMENT
        ↓
RADIO = ONE VALUE TO SEND
        ↓
DESTINATION
        ↓
SEND
        ↓
EXACT AUTHORIZED NODE FIELD
```

The Attribute list must ALWAYS be dynamic and element-specific.

This is a mandatory architectural and UX requirement.