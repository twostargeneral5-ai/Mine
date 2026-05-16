/*
 * lean25.c  –  Lean Cuckoo Cycle solver
 *   EDGEBITS = 25  (NEDGES = 33,554,432)
 *   PROOFSIZE = 42
 *
 * Protocol (stdin/stdout, line-delimited):
 *   Input  : 64-char lowercase hex  (32-byte seed)
 *   Output : "CYCLE e0 e1 ... e41\n"  when a 42-cycle is found
 *            "NONE\n"                  when not found
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

/* ── constants ─────────────────────────────────────────────────── */
#define EDGEBITS    25
#define NEDGES      (1U << EDGEBITS)      /* 33,554,432          */
#define NODEMASK    ((NEDGES) - 1U)
#define PROOFSIZE   42
#define TRIM_ROUNDS 80                    /* more rounds → fewer survivors */
#define MAXPATHLEN  8192

typedef uint64_t u64;
typedef uint32_t u32;
typedef uint8_t  u8;

/* ── SipHash-2-4 ────────────────────────────────────────────────── */
#define ROTL(x,b) ((u64)(((x)<<(b))|((x)>>(64-(b)))))
#define SR \
  v0+=v1; v1=ROTL(v1,13); v1^=v0; v0=ROTL(v0,32); \
  v2+=v3; v3=ROTL(v3,16); v3^=v2; \
  v0+=v3; v3=ROTL(v3,21); v3^=v0; \
  v2+=v1; v1=ROTL(v1,17); v1^=v2; v2=ROTL(v2,32);

typedef struct { u64 v0,v1,v2,v3; } siphash_keys;

static inline u64 siphash24(const siphash_keys *k, u64 n) {
  u64 v0=k->v0, v1=k->v1, v2=k->v2, v3=k->v3^n;
  SR; SR;
  v0^=n; v2^=0xff;
  SR; SR; SR; SR;
  return v0^v1^v2^v3;
}

static inline u32 sipnode(const siphash_keys *k, u32 e, u32 uv) {
  return (u32)(siphash24(k, (u64)e*2+uv) & NODEMASK);
}

static void seed_to_keys(siphash_keys *k, const char *hex) {
  u8 b[32];
  for (int i=0;i<32;i++){
    unsigned v=0; sscanf(hex+2*i,"%02x",&v); b[i]=(u8)v;
  }
  /* 4 × uint64 little-endian */
  #define LE64(off) ( (u64)b[off]|(u64)b[off+1]<<8|(u64)b[off+2]<<16| \
    (u64)b[off+3]<<24|(u64)b[off+4]<<32|(u64)b[off+5]<<40| \
    (u64)b[off+6]<<48|(u64)b[off+7]<<56 )
  k->v0=LE64( 0); k->v1=LE64( 8);
  k->v2=LE64(16); k->v3=LE64(24);
  #undef LE64
  /* XOR with SipHash init constants */
  k->v0^=0x736f6d6570736575ULL;
  k->v1^=0x646f72616e646f6dULL;
  k->v2^=0x6c7967656e657261ULL;
  k->v3^=0x7465646279746573ULL;
}

/* ── bitmaps ─────────────────────────────────────────────────────── */
#define BMLEN ((NEDGES+31)/32)

static u32 alive_bm[BMLEN];    /* 4 MB  – 1 bit per edge  */
static u32 deg0_bm [BMLEN];    /* 4 MB  – degree bit-0    */
static u32 deg1_bm [BMLEN];    /* 4 MB  – degree bit-1 (2+) */

#define GETB(bm,i)  (((bm)[(i)>>5]>>((i)&31))&1u)
#define SETB(bm,i)  ((bm)[(i)>>5] |=  (1u<<((i)&31)))
#define CLRB(bm,i)  ((bm)[(i)>>5] &= ~(1u<<((i)&31)))

static inline void deg_inc(u32 nd) {
  if (!GETB(deg1_bm,nd)) {
    if (GETB(deg0_bm,nd)) SETB(deg1_bm,nd);
    else                  SETB(deg0_bm,nd);
  }
}

static void trim(const siphash_keys *k) {
  memset(alive_bm,0xff,sizeof(alive_bm));
  /* clear stray high bits in last word */
  if (NEDGES%32) alive_bm[NEDGES/32]=(1u<<(NEDGES%32))-1;

  for (int rd=0; rd<TRIM_ROUNDS; rd++) {
    for (int uv=0; uv<=1; uv++) {
      memset(deg0_bm,0,sizeof(deg0_bm));
      memset(deg1_bm,0,sizeof(deg1_bm));
      for (u32 e=0;e<NEDGES;e++)
        if (GETB(alive_bm,e)) deg_inc(sipnode(k,e,uv));
      for (u32 e=0;e<NEDGES;e++)
        if (GETB(alive_bm,e))
          if (!GETB(deg1_bm,sipnode(k,e,uv)))
            CLRB(alive_bm,e);
    }
  }
}

/* ── cuckoo hashtable cycle detection ───────────────────────────── */
/*
 * Table maps node → partner.  We use nodes + 1 so 0 == empty.
 * U-nodes: stored as (node+1).
 * V-nodes: stored as (node+1+NEDGES)  to keep namespaces separate.
 * Table size must be larger than any live node index.
 * 2 × NEDGES × 4 bytes = 256 MB.  Use a hashed table instead.
 */
#define CTBITS 22                          /* 2^22 = 4M slots = 16 MB */
#define CTSIZE (1U << CTBITS)
#define CTMASK (CTSIZE - 1U)

static u32 ct_key[CTSIZE];    /* 16 MB */
static u32 ct_val[CTSIZE];    /* 16 MB */

static void ct_clear(void) {
  memset(ct_key,0,sizeof(ct_key));
  memset(ct_val,0,sizeof(ct_val));
}

/* Open-addressed insert: key → value.  key must not be 0. */
static void ct_set(u32 key, u32 val) {
  u32 slot = key & CTMASK;
  while (ct_key[slot] && ct_key[slot]!=key) slot=(slot+1)&CTMASK;
  ct_key[slot]=key; ct_val[slot]=val;
}

static u32 ct_get(u32 key) {
  u32 slot = key & CTMASK;
  while (ct_key[slot] && ct_key[slot]!=key) slot=(slot+1)&CTMASK;
  return ct_key[slot] ? ct_val[slot] : 0;
}

/* Walk path from node u back to tree root.  Returns depth. */
static u32 cpath(u32 u, u32 *nodes) {
  u32 depth=0;
  for (; u; u=ct_get(u)) {
    if (depth>MAXPATHLEN) return MAXPATHLEN+1;
    nodes[depth++]=u;
  }
  nodes[depth]=0;
  return depth;
}

/* Find the alive edge connecting node u and node v (with +1 offsets removed) */
static u32 edge_between(const siphash_keys *k, u32 uraw, u32 vraw) {
  /* uraw = U-node value, vraw = V-node value (both without +1 or +NEDGES) */
  for (u32 e=0;e<NEDGES;e++) {
    if (!GETB(alive_bm,e)) continue;
    if (sipnode(k,e,0)==uraw && sipnode(k,e,1)==vraw) return e;
    if (sipnode(k,e,0)==vraw && sipnode(k,e,1)==uraw) return e;
  }
  return 0xFFFFFFFF;
}

/* Given us[] path and vs[] path of depth nu/nv, extract cycle edge indices */
static int extract_cycle(const siphash_keys *k,
                          u32 u0, u32 v0,
                          u32 *us, u32 nu,
                          u32 *vs, u32 nv,
                          u32 *proof) {
  /* Build full node sequence for u-side and v-side */
  u32 uchain[MAXPATHLEN+2], vchain[MAXPATHLEN+2];
  uchain[0]=u0;
  for (u32 i=0;i<nu;i++) uchain[i+1]=us[i];
  vchain[0]=v0;
  for (u32 i=0;i<nv;i++) vchain[i+1]=vs[i];

  /* For each consecutive pair in the chains, find the edge */
  u32 idx=0;
  for (u32 i=0;i<nu+1 && idx<PROOFSIZE;i++) {
    u32 a=uchain[i], b=(i+1<=nu)?uchain[i+1]:vs[nv-1];
    /* Remove encoding offsets */
    u32 ua = (a<=NEDGES) ? a-1 : a-1-NEDGES;
    u32 ub = (b<=NEDGES) ? b-1 : b-1-NEDGES;
    u32 e = edge_between(k, ua, ub);
    if (e!=0xFFFFFFFF) {
      /* avoid duplicates */
      int dup=0; for(u32 j=0;j<idx;j++) if(proof[j]==e){dup=1;break;}
      if (!dup && idx<PROOFSIZE) proof[idx++]=e;
    }
  }
  for (u32 i=0;i<nv && idx<PROOFSIZE;i++) {
    u32 a=vchain[i], b=vchain[i+1];
    u32 ua = (a<=NEDGES) ? a-1 : a-1-NEDGES;
    u32 ub = (b<=NEDGES) ? b-1 : b-1-NEDGES;
    u32 e = edge_between(k, ua, ub);
    if (e!=0xFFFFFFFF) {
      int dup=0; for(u32 j=0;j<idx;j++) if(proof[j]==e){dup=1;break;}
      if (!dup && idx<PROOFSIZE) proof[idx++]=e;
    }
  }
  return (int)idx;
}

static int solve(const siphash_keys *k, u32 *proof) {
  ct_clear();
  u32 us[MAXPATHLEN+2], vs[MAXPATHLEN+2];

  for (u32 e=0; e<NEDGES; e++) {
    if (!GETB(alive_bm,e)) continue;
    /* Encode: U-node → use as-is (+1 to avoid 0), V-node → +1+NEDGES */
    u32 u = sipnode(k,e,0) + 1;
    u32 v = sipnode(k,e,1) + 1 + NEDGES;

    u32 nu = cpath(u,us);
    u32 nv = cpath(v,vs);
    if (nu>MAXPATHLEN || nv>MAXPATHLEN) continue;

    if (us[nu] == vs[nv]) {
      u32 len = nu + nv + 1;
      if (len == PROOFSIZE) {
        int n = extract_cycle(k, u, v, us, nu, vs, nv, proof);
        if (n == PROOFSIZE) {
          /* sort */
          for (u32 i=0;i<PROOFSIZE-1;i++)
            for (u32 j=i+1;j<PROOFSIZE;j++)
              if (proof[i]>proof[j]){u32 t=proof[i];proof[i]=proof[j];proof[j]=t;}
          return 1;
        }
      }
      /* wrong-length cycle — prune and continue */
      if (nu < nv) {
        for (u32 i=nu;i>0;i--) ct_set(us[i],us[i-1]);
        ct_set(u,v);
      } else {
        for (u32 i=nv;i>0;i--) ct_set(vs[i],vs[i-1]);
        ct_set(v,u);
      }
    } else {
      /* join trees */
      if (nu < nv) {
        for (u32 i=nu;i>0;i--) ct_set(us[i],us[i-1]);
        ct_set(u,v);
      } else {
        for (u32 i=nv;i>0;i--) ct_set(vs[i],vs[i-1]);
        ct_set(v,u);
      }
    }
  }
  return 0;
}

/* ── main ───────────────────────────────────────────────────────── */
int main(void) {
  char line[128];
  while (fgets(line,sizeof(line),stdin)) {
    line[strcspn(line,"\n\r")]=0;
    if (strlen(line)<64) { puts("NONE"); fflush(stdout); continue; }

    siphash_keys k;
    seed_to_keys(&k, line);
    trim(&k);

    u32 proof[PROOFSIZE];
    if (solve(&k, proof)) {
      printf("CYCLE");
      for (int i=0;i<PROOFSIZE;i++) printf(" %u",proof[i]);
      printf("\n");
    } else {
      printf("NONE\n");
    }
    fflush(stdout);
  }
  return 0;
}
