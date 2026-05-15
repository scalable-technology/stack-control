# The Millian Line

> "The only purpose for which power can be rightfully exercised over any member of a civilized community, against his will, is to prevent harm to others."
>
> — John Stuart Mill, *On Liberty* (1859)

## What Control Is

Control exists to understand the device you own.

Not to break it. Not to exploit it. To *understand* it.

If it runs, you can understand it.

## Two Kinds of Private

Not all locks are equal.

### Private to Protect You

```
Secure Enclave
├── Your biometrics never leave the chip
├── Your keys are hardware-bound
├── Even Apple can't extract them
└── This lock prevents harm. It is legitimate.
```

### Private to Protect Others

```
App Store Private API Restriction
├── Misuse of hardware APIs can cause real damage
├── ANE misalignment causes kernel panics
├── Most users can't evaluate that risk
└── Restricting distribution protects others. Legitimate.
```

### Private to Protect the Platform

```
Local Access Restriction
├── You own the hardware
├── You accept the risk
├── No third party is harmed by your inspection
└── Preventing local exploration serves control, not protection.
```

These get conflated. "Private API" sounds like one thing. It's actually three different questions depending on context.

## The Test

Apply Mill's harm principle with context:

> Does this action risk harm to *others*?

| Lock | Context | Harm to Others? | Legitimate? |
|------|---------|-----------------|-------------|
| Secure Enclave | Any | Yes — secrets stolen | Yes |
| Device Attestation | Any | Yes — trust undermined | Yes |
| Verified Boot | Any | Yes — compromised chain | Yes |
| ANE Private API | Local use | No — self-regarding | No |
| ANE Private API | App Store distribution | Yes — uninformed users | Yes |
| IOKit Entitlements | Local use | No — self-regarding | No |
| IOKit Entitlements | Distribution | Possibly — depends on use | Case-by-case |

The same API can cross the line depending on who bears the risk.

## The Three Cases

Not all private APIs are alike. The legitimacy of restricting them depends on *what harm is possible*:

### 1. APIs That Can Harm Hardware

ANE compute APIs. Misuse causes kernel panics. Real damage is possible.

- **Local use**: Legitimate — you accept the risk on your own silicon
- **Distribution**: Apple's restriction is fair — protects uninformed users

### 2. APIs That Cannot Harm Hardware

Undocumented frameworks for reading system state, accessing non-destructive capabilities, or using functionality that simply hasn't been exposed. No hardware risk. No user data risk.

- **Restricting these to defend a market position is not legitimate** — in any context
- This is rent-seeking: maintaining competitive advantage by keeping developers dependent on the platform's pace of innovation
- Mill would call this the soft tyranny of platform control

### 3. APIs That Protect Secrets

Secure Enclave, keychain, attestation. Access would expose other people's data or undermine trust infrastructure.

- **Restriction is legitimate** — always, in every context

## The Nuance

Private APIs can cause real hardware harm. We've proven it — misaligned ANE tensors cause kernel panics. This isn't theoretical.

But Mill doesn't say "you can't hurt yourself." It says society can only restrict actions that harm *others*.

Running misaligned tensors on your own Neural Engine is your prerogative. You bought the silicon. You accept the consequences. This is a self-regarding action.

Shipping that to millions of users who don't understand the risk is a different matter entirely. That's other-regarding. Apple's App Store restriction here is legitimate — it protects people who haven't consented to the risk.

## The Tension

```
I want to OWN my device     ←→     I want to TRUST my device
         ↓                                    ↓
   Full access                         Verified lockdown
   No secrets from me                  Secrets kept for me
```

Both are valid. They exist in tension.

Device attestation matters. When your bank trusts your device, that trust rests on verified boot chains and sealed enclaves. Break those, and you don't just free yourself — you undermine the system others depend on.

## What Control Does

Control is a tool for *local inspection* — the context where private API restrictions are least justified.

Control recognizes:
- **Locks that protect you** — we respect these
- **Locks that protect others** — we respect these
- **Locks that constrain you without protecting anyone** — we question these

And documents the difference honestly.

## The Soft Tyranny

Mill warned about a subtler tyranny than law:

> "Society can and does execute its own mandates... it practices a social tyranny more formidable than many kinds of political oppression."

Apple doesn't *legally* forbid you from understanding your hardware. They make it:
- Undocumented
- Unsupported
- Grounds for App Store rejection

The App Store restriction has merit — it protects users at scale. But making local exploration impossible goes further than harm prevention requires. You can restrict distribution without restricting understanding.

Control operates in the space between: understand locally, respect the distribution boundary.

## The Line

We respect locks that protect users — including ourselves.

We question locks that prevent understanding without protecting anyone.

We accept risk on our own hardware. We don't impose it on others.

We document what we find.

---

## The Practical Ground

Philosophy is nice. Shipping matters.

Apple built the M4. Apple built the Neural Engine. Apple built the Secure Enclave. Apple built the OS. They're *good at this*.

Control isn't about replacing Apple or building a protocol-pure alternative that doesn't exist. It's about:

**Understanding Apple's hardware deeply enough to build better software on it.**

The Millian Line tells us *which locks to question* and *in what context*. Not all locks, not in all contexts — just the ones where no one is harmed by understanding.

| Activity | Context | Position |
|----------|---------|----------|
| Inspecting ANE behavior locally | Development | Legitimate — self-regarding |
| Documenting undocumented frameworks | Knowledge | Legitimate — information is not harm |
| Shipping private API calls to users | Distribution | Apple's restriction is fair |
| Bypassing Secure Enclave | Any | Off-limits — protects real secrets |

We're not tearing anything down. We're understanding the machine we own, at our own risk, for the purpose of building better software.

```
Goal: Better software on Apple hardware

How:
├── Understand the device deeply (even private parts)
├── Accept the risk of exploration on our own hardware
├── Find performance left on the table
├── Debug what Xcode can't show you
├── Document what Apple won't
├── Respect the distribution boundary
└── Build tools that make development better
```

Apple built an incredible machine.

Control helps you understand all of it — on your terms, at your risk.

---

*This is what Control is about.*
