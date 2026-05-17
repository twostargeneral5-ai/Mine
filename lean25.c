/*
 * lean25.c  –  Cuckoo Cycle lean miner
 *   EDGEBITS=25  NODEBITS=24  PROOFSIZE=42
 *   NODEBITS=24 gives edge density=2, enough 42-cycles to mine.
 *   Uses direct-index cuckoo table (no hash collisions possible).
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#define EDGEBITS  25
#define NODEBITS  24
#define NEDGES    (1u << EDGEBITS)         /* 33,554,432 edges    */
#define NNODES    (1u << NODEBITS)         /* 16,777,216 per side */
#define NODEMASK  (NNODES - 1u)            /* 16,777,215          */
#define VOFF      NNODES                   /* V-node offset       */
#define CTSIZE    (NNODES * 2 + 2)         /* 33,554,434 slots, 128MB */
#define PROOFSIZE 42
#define TRIM_ROUNDS 80
#define MAXPATH   8192

typedef uint64_t u64;
typedef uint32_t u32;
typedef uint8_t  u8;

/* ── SipHash-2-4 ─────────────────────────────────────────────── */
#define ROTL(x,b) ((u64)(((x)<<(b))|((x)>>(64-(b)))))
#define SR \
  v0+=v1;v1=ROTL(v1,13);v1^=v0;v0=ROTL(v0,32);\
  v2+=v3;v3=ROTL(v3,16);v3^=v2;\
  v0+=v3;v3=ROTL(v3,21);v3^=v0;\
  v2+=v1;v1=ROTL(v1,17);v1^=v2;v2=ROTL(v2,32);

typedef struct { u64 v0,v1,v2,v3; } sip_t;

static inline u64 sip24(const sip_t *k, u64 n) {
  u64 v0=k->v0,v1=k->v1,v2=k->v2,v3=k->v3^n;
  SR;SR; v0^=n; v2^=0xff; SR;SR;SR;SR;
  return v0^v1^v2^v3;
}
static inline u32 sipnode(const sip_t *k, u32 e, u32 uv) {
  return (u32)(sip24(k,(u64)e*2+uv) & NODEMASK);
}
static void hexseed(sip_t *k, const char *h) {
  u8 b[32];
  for(int i=0;i<32;i++){unsigned v;sscanf(h+2*i,"%02x",&v);b[i]=(u8)v;}
#define L8(o) ((u64)b[o]|(u64)b[o+1]<<8|(u64)b[o+2]<<16|(u64)b[o+3]<<24|\
               (u64)b[o+4]<<32|(u64)b[o+5]<<40|(u64)b[o+6]<<48|(u64)b[o+7]<<56)
  k->v0=L8(0)^0x736f6d6570736575ULL; k->v1=L8(8)^0x646f72616e646f6dULL;
  k->v2=L8(16)^0x6c7967656e657261ULL; k->v3=L8(24)^0x7465646279746573ULL;
}

/* ── Trimming bitmaps ─────────────────────────────────────────── */
#define BMLEN ((NEDGES+31)/32)
static u32 alive[BMLEN], d0[BMLEN], d1[BMLEN];
#define GB(b,i) (((b)[(i)>>5]>>((i)&31))&1u)
#define SB(b,i) ((b)[(i)>>5]|=(1u<<((i)&31)))
#define CB(b,i) ((b)[(i)>>5]&=~(1u<<((i)&31)))

static void trim(const sip_t *k) {
  memset(alive,0xff,sizeof(alive));
  if(NEDGES%32) alive[NEDGES/32]=(1u<<(NEDGES%32))-1;
  for(int r=0;r<TRIM_ROUNDS;r++){
    for(int uv=0;uv<=1;uv++){
      memset(d0,0,sizeof(d0)); memset(d1,0,sizeof(d1));
      for(u32 e=0;e<NEDGES;e++)
        if(GB(alive,e)){
          u32 nd=sipnode(k,e,uv);
          if(!GB(d1,nd)){if(GB(d0,nd))SB(d1,nd);else SB(d0,nd);}
        }
      for(u32 e=0;e<NEDGES;e++)
        if(GB(alive,e))
          if(!GB(d1,sipnode(k,e,uv))) CB(alive,e);
    }
  }
}

/* ── Direct-index cuckoo table (no hash collisions) ─────────── */
/* Encoding: u-node x → (x+1),  v-node y → (y+1+VOFF)          */
/* 0 = empty. Values fit in [1, 2*NNODES+1] = [1, 33554433].    */
static u32 *ct = NULL;   /* CTSIZE entries, allocated on heap     */

static u32 cpath(u32 u, u32 *us) {
  u32 n=0;
  for(;u;u=ct[u]){
    if(n>=MAXPATH) return MAXPATH+1;
    us[n++]=u;
  }
  us[n]=0; return n;
}

static int solve(const sip_t *k, u32 *proof) {
  memset(ct,0,CTSIZE*sizeof(u32));
  u32 us[MAXPATH+2], vs[MAXPATH+2];

  for(u32 e=0;e<NEDGES;e++){
    if(!GB(alive,e)) continue;
    u32 u0 = sipnode(k,e,0)+1;
    u32 v0 = sipnode(k,e,1)+1+VOFF;
    u32 u = ct[u0], v = ct[v0];
    u32 nu = cpath(u,us), nv = cpath(v,vs);
    if(nu>MAXPATH||nv>MAXPATH) continue;

    if(us[nu]==vs[nv]) {
      u32 len=nu+nv+1;
      if(len==PROOFSIZE) {
        /* Build full node path and find edges */
        u32 seq[PROOFSIZE+2], ns=0;
        seq[ns++]=u0;
        for(u32 i=0;i<nu;i++) seq[ns++]=us[i];
        for(int i=(int)nv-1;i>=0;i--) seq[ns++]=vs[i];
        seq[ns++]=v0;

        u32 found=0;
        for(u32 p=0;p+1<ns&&found<PROOFSIZE;p++){
          u32 a=seq[p],b=seq[p+1];
          u32 ra=(a>VOFF)?a-1-VOFF:a-1;
          u32 rb=(b>VOFF)?b-1-VOFF:b-1;
          for(u32 ee=0;ee<NEDGES;ee++){
            if(!GB(alive,ee)) continue;
            u32 eu=sipnode(k,ee,0),ev=sipnode(k,ee,1);
            if((eu==ra&&ev==rb)||(eu==rb&&ev==ra)){
              proof[found++]=ee; break;
            }
          }
        }
        if(found==PROOFSIZE){
          for(int a=0;a<PROOFSIZE-1;a++)
            for(int b=a+1;b<PROOFSIZE;b++)
              if(proof[a]>proof[b]){u32 t=proof[a];proof[a]=proof[b];proof[b]=t;}
          return 1;
        }
      }
      /* wrong length — join & continue */
      if(nu<nv){for(u32 i=nu;i>0;i--)ct[us[i]]=us[i-1];ct[u0]=v0;}
      else      {for(u32 i=nv;i>0;i--)ct[vs[i]]=vs[i-1];ct[v0]=u0;}
    } else {
      if(nu<nv){for(u32 i=nu;i>0;i--)ct[us[i]]=us[i-1];ct[u0]=v0;}
      else      {for(u32 i=nv;i>0;i--)ct[vs[i]]=vs[i-1];ct[v0]=u0;}
    }
  }
  return 0;
}

int main(void){
  ct=(u32*)calloc(CTSIZE,sizeof(u32));
  if(!ct){fprintf(stderr,"malloc failed\n");return 1;}
  char line[128]; u32 proof[PROOFSIZE];
  while(fgets(line,sizeof(line),stdin)){
    line[strcspn(line,"\n\r")]=0;
    if(strlen(line)<64){puts("NONE");fflush(stdout);continue;}
    sip_t k; hexseed(&k,line); trim(&k);
    if(solve(&k,proof)){
      printf("CYCLE");
      for(int i=0;i<PROOFSIZE;i++) printf(" %u",proof[i]);
      printf("\n");
    } else printf("NONE\n");
    fflush(stdout);
  }
  free(ct); return 0;
}
