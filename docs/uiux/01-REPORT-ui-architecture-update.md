# Aria Automate — UI Architecture Update Report (source, verbatim)

> Product-owner report received 2026-07-28 together with the two locked images
> `workspace-overview.webp` and `shell-editor-launcher-menu.webp`.
> Kept **verbatim** (Persian) as the requirement of record. The implementation
> specs derived from it are `workspace-overview.md` and
> `shell-editor-launcher-menu.md`; where the report and a locked image disagree,
> the image wins (noted inline in those specs).

---

این گزارش را می‌تونی مستقیم به Agent طراحی UI/UX بدهی تا بر اساس آن پیاده‌سازی کند:

---

# Aria Automate UI Architecture Update Report

## هدف اصلی تغییر

بازطراحی ساختار محصول به شکلی که **Workspace مرکز مدیریت Workflowها باشد** و ابزارهای مرتبط با هر Workflow از منوی اصلی جدا شوند.

ساختار قبلی باعث شلوغی Navigation شده بود؛ بنابراین تصمیم گرفته شد Sidebar فقط شامل بخش‌های اصلی سیستم باشد و امکانات مربوط به هر Workflow داخل Workspace مدیریت شوند.

---

# 1. تغییر ساختار Navigation اصلی

## Sidebar اصلی فقط شامل:

```
Home
Workspace
Dashboard
Jobs
Admin
Settings
```

### حذف شدند:

* Live View
* Live Browser
* Schedules
* Active Flow

این موارد دیگر Navigation اصلی نیستند و به قابلیت‌های هر Workflow منتقل می‌شوند.

---

# 2. تغییر Header

در UI اصلی:

قبلاً:

```
Logo
Home
Workspace
...
```

تبدیل شود به:

```
Logo

[ App Launcher Icon ]
```

آیکن:

* چهار مربع شبیه Windows 11 Launcher
* قابل Hover / Click
* باز شدن یک منوی کوچک Floating

داخل منوی Launcher:

```
Home
Workspace
Dashboard
Jobs
Admin
Settings
```

---

# 3. Workspace به عنوان مرکز اصلی Workflow Management

وقتی کاربر وارد Workspace می‌شود:

صفحه مشابه n8n Workflow Overview باشد.

هدف:

مدیریت:

* Workflowها
* Statistics
* Schedules
* Executions
* Connections

---

# 4. Workspace Dashboard Statistics

بالای صفحه کارت‌های آماری قرار بگیرد.

ترتیب دقیق کارت‌ها:

## 1. Total Flows

تعداد کل Workflowها

Example:

```
Total Flows

42

All workflows
```

---

## 2. Active Schedules

تعداد Scheduleهای فعال

Example:

```
Active Schedules

18

Schedules running
```

---

## 3. Active Flows

تعداد Workflowهای فعال

Example:

```
Active Flows

16

Currently active
```

---

## 4. Overall Success Rate

درصد موفقیت کلی Automationها

Example:

```
Success Rate

98.4%

Overall success
```

---

## 5. Failures

تعداد خطاها

Example:

```
Failures

23

Failed runs
```

---

## 6. Active Jobs

Jobهای در حال اجرا

Example:

```
Active Jobs

7

Jobs in progress
```

---

## 7. Live Browsers

تعداد Browser Sessionهای فعال

Example:

```
Live Browsers

4

Browsers active
```

---

# 5. Workflow List Design

هر Workflow یک Card/Row مانند n8n داشته باشد.

اطلاعات:

```
Workflow Name

Description

Owner

Last Run

Success Rate

Status

Live Browser

Schedules

Actions
```

---

# 6. Active Workflow System

هر Workflow دارای Toggle باشد:

```
Active  ●
Inactive ○
```

اگر Workflow خاموش باشد:

* اجرا نمی‌شود
* Job ایجاد نمی‌کند
* Live Browser قابل مشاهده نیست

---

# 7. Live Browser Feature

Live Browser یک قابلیت مستقل برای هر Workflow است.

هر Workflow:

```
Live Browser Toggle

ON / OFF
```

اگر فعال باشد:

```
[ Toggle ON ]

[ 👁 Eye Icon ]
```

کاربر بتواند Browser Automation را مشاهده کند.

---

## منطق مهم:

### حالت 1:

Workflow فعال:

```
Flow: Active

Live Browser: ON

Eye Icon:
فعال
قابل کلیک
```

---

### حالت 2:

Workflow غیرفعال:

```
Flow: Inactive

Live Browser: ON
```

نمایش:

```
Live Browser
ON (gray)

Eye Icon
Disabled / Gray
```

دلیل:

Browser وجود ندارد چون Automation اجرا نمی‌شود.

---

### حالت 3:

Workflow فعال:

```
Flow Active

Live Browser OFF
```

نمایش:

```
Toggle OFF

Eye Icon Hidden/Disabled
```

---

# 8. Workflow Options

گزینه‌های زیر باید متعلق به هر Workflow باشند، نه Sidebar:

```
Open Editor

Live Browser

Schedules

Executions

Connections

Settings

Duplicate

Export
```

---

# 9. ارتباط با Playwright

چون Automation Engine بر پایه Playwright است:

Live Browser باید قابلیت:

* Headless Browser
* Visible Browser

را مدیریت کند.

وقتی Live Browser فعال است:

کاربر بتواند Session واقعی مرورگر را مشاهده کند.

---

# 10. Design Rules

## حفظ شود:

* Dark Theme
* Orange Accent
* Rounded Cards
* Minimal Enterprise UI
* مشابه n8n/Figma/Linear

## جلوگیری شود از:

* شلوغی Sidebar
* نمایش امکانات غیرمرتبط
* Navigation زیاد

---

# Final Product Flow

```
Login

 ↓

Workspace

 ↓

Select Workflow

 ↓

Workflow Editor

 ├── Canvas
 ├── Live Browser
 ├── Schedules
 ├── Executions
 ├── Connections
 └── Settings
```

---

هدف نهایی:

**Workspace = مدیریت همه Automationها**

**Workflow Editor = ساخت و اجرای Automation**

**Live Browser / Schedule / Execution = قابلیت‌های هر Workflow**

این ساختار باعث می‌شود Aria Automate مقیاس‌پذیرتر و نزدیک‌تر به یک محصول Enterprise Automation Platform شود.
