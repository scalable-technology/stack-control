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

### Private to Protect the Platform

```
ANE API
├── It's just matrix math on silicon
├── No secrets are protected by hiding it
├── Locking it doesn't make you safer
└── This lock serves control, not protection.
```

These get conflated. "Private API" sounds like "private key." It's not.

## The Test

Apply Mill's harm principle:

> Does hiding this prevent harm to someone?

| Lock | Harm Prevented | Legitimate? |
|------|----------------|-------------|
| Secure Enclave | Your secrets stolen | Yes |
| Device Attestation | Malware posing as you | Yes |
| Verified Boot | Compromised boot chain | Yes |
| ANE Private API | None | No |
| IOKit Entitlements | None (mostly) | No |
| Undocumented Frameworks | None | No |

If no harm is prevented, the lock serves the platform, not the user.

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

Control is not about breaking every lock.

Control is about recognizing:
- **Locks that protect you** — we respect these
- **Locks that constrain you** — we question these

And documenting the difference.

## The Soft Tyranny

Mill warned about a subtler tyranny than law:

> "Society can and does execute its own mandates... it practices a social tyranny more formidable than many kinds of political oppression."

Apple doesn't *legally* forbid you from understanding your hardware. They make it:
- Undocumented
- Unsupported
- Grounds for App Store rejection

Not illegal. Just impossible to do legitimately.

Control makes it possible.

## The Line

We respect locks that protect the user.

We question locks that constrain the user.

We document what we find.

---

## The Practical Ground

Philosophy is nice. Shipping matters.

Apple built the M4. Apple built the Neural Engine. Apple built the Secure Enclave. Apple built the OS. They're *good at this*.

Control isn't about replacing Apple or building a protocol-pure alternative that doesn't exist. It's about:

**Making Apple's ecosystem more secure, more efficient, and better DX/UX.**

The Millian Line tells us *which locks to question*. Not all of them — just the ones that serve control instead of protection.

| Illegitimate Lock | Why It Matters (Practically) |
|-------------------|------------------------------|
| ANE private API | We could ship faster ML on-device |
| IOKit friction | We could build better hardware integrations |
| Undocumented frameworks | We could solve problems Apple hasn't prioritized |

We're not tearing anything down. We're using it better than Apple expects.

```
Goal: Better software on Apple hardware

How:
├── Understand the device deeply (even private parts)
├── Find performance left on the table
├── Debug what Xcode can't show you
├── Document what Apple won't
└── Build tools that make development better
```

Apple built an incredible machine.

Control helps you use all of it.

---

*This is what agent-tyrauber-control is about.*
