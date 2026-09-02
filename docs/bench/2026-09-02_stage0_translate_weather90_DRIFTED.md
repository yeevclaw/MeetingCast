## Streaming bench — weather_90s.wav (90s audio, 47 segments, alignment coverage 69%)

| 指標 | 值 |
|---|---|
| 片段長度（字） | P50 10 / P95 15 / max 15 字 (n=47) |
| 片段落在 5–15 字 | 89%（<5: 11%, >15: 0%） |
| boundary 分佈 | {'clause': 18, 'forced': 15, 'sentence': 11, 'pause': 3} |
| STT delta 落後（字說出 → 字上螢幕） | P50 4730 / P95 6902 / max 7227 ms (n=332) |
| 片段 final 落後（最後一字說出 → final 到達） | P50 4961 / P95 7079 / max 7384 ms (n=47) |
| 翻譯首 token TTFT | P50 662 / P95 1052 / max 1728 ms (n=46) |
| 翻譯完成 | P50 812 / P95 1255 / max 1837 ms (n=46) |
| **端到端：片段最後一字說出 → 譯文首字** | **P50 5566 / P95 7829 / max 8122 ms (n=46)** |
| **端到端：片段第一字說出 → 譯文首字** | **P50 7220 / P95 9978 / max 10384 ms (n=46)** |

| # | 到達 s | boundary | 字 | 說出區間 s | final 落後 ms | TTFT ms | 源文 | 譯文 |
|--:|--:|---|--:|---|--:|--:|---|---|
| 0 | 3.59 | clause | 6 | 0.3–1.4 | 2232 | 770 | 好，大家下午好， | Good afternoon, everyone. |
| 1 | 6.32 | clause | 13 | 1.6–3.4 | 2880 | 599 | 在今天呢是一个闷而热的天气， | It's a sultry and hot day today. |
| 2 | 9.49 | forced | 15 | 3.8–6.3 | 3190 | 657 | 不过呢午后阵雨在局部的山区有发 | However, in the afternoon, scattered showers will occur locally in the mountainous areas. |
| 3 | 10.77 | clause | 7 | 6.7–7.9 | 2846 | 676 | 展，量来说并不多， | The volume is not very large. |
| 4 | 13.53 | forced | 15 | 8.2–10.6 | 2954 | 737 | 但明天要注意的就在于外出活动要 | But the key thing to watch out for tomorrow is that outdoor activities need to |
| 5 | 14.14 | clause | 4 | 10.9–11.3 | 2856 | 720 | 备雨具了， | Got an umbrella ready. |
| 6 | 17.08 | forced | 15 | 11.5–14.1 | 3000 | 650 | 因为锋面云带随着在明天中午以后 | Because the frontal cloud system will move in after tomorrow noon |
| 7 | 18.34 | pause | 5 | 14.5–15.2 | 3095 | 659 | 开始逐渐的 | Start gradually. |
| 8 | 19.18 | clause | 6 | 15.4–16.1 | 3102 | 647 | 得要往南移动， | We need to move south. |
| 9 | 20.42 | sentence | 9 | 16.4–17.1 | 3323 | 586 | 也就是要接近台湾啰。 | So it means we need to get closer to Taiwan. |
| 10 | 22.14 | clause | 10 | 17.8–18.5 | 3682 | 611 | 好，我们来看一下时间点， | Okay, let's look at the timeline. |
| 11 | 23.38 | sentence | 7 | 19.2–20.1 | 3282 | 1359 | 需要注意什么了？ | What do I need to pay attention to? |
| 12 | 24.85 | clause | 3 | 20.3–20.4 | 4426 | 749 | 第一个， | The first one, |
| 13 | 27.17 | forced | 15 | 21.2–23.7 | 3487 | 628 | 明天上午的时候呢快接近中午左右 | Tomorrow morning, getting close to around noon. |
| 14 | 30.12 | forced | 15 | 23.9–26.4 | 3756 | 723 | 呢在这个北部跟东半部地区会因为 | In this northern and eastern region areas, it will be because of |
| 15 | 32.23 | clause | 7 | 27.1–27.8 | 4389 | 806 | 云层量开始增多， | Cloud coverage is beginning to increase. |
| 16 | 33.79 | sentence | 11 | 28.6–30.2 | 3553 | 716 | 锋面云带的云层开始接近。 | The frontal cloud band is starting to approach. |
| 17 | 37.29 | forced | 15 | 30.4–33.2 | 4094 | 656 | 所以就会有些赠与或雷雨的现象在 | So there will be some phenomena of giveaways or thunderstorms. |
| 18 | 39.61 | sentence | 11 | 33.4–35.1 | 4509 | 667 | 明天的中午左右开始出现。 | It will start appearing around noon tomorrow. |
| 19 | 40.66 | clause | 3 | 35.5–35.7 | 4961 | 663 | 所以呢， | So, |
| 20 | 42.28 | clause | 12 | 36.0–37.8 | 4516 | 787 | 如果你是在北部活动的朋友， | If you're a friend who's active in the northern region, |
| 21 | 44.06 | sentence | 10 | 38.0–39.2 | 4905 | 602 | 早上出门就要备雨具哦。 | You should bring an umbrella when you go out in the morning. |
| 22 | 46.63 | clause | 9 | 39.9–41.2 | 5450 | 637 | 而到了下午的时候呢， | In the afternoon, then, |
| 23 | 49.35 | forced | 15 | 42.4–44.6 | 4749 | 588 | 云层发展逐渐的由这个北部往中部 | Cloud development is gradually moving from the northern part to the central area. |
| 24 | 49.86 | sentence | 5 | 44.7–45.3 | 4556 | 646 | 的方向移动。 | moving in that direction. |
| 25 | 53.14 | forced | 15 | 45.7–48.1 | 5061 | 649 | 所以在中部的朋友就会注意到早上 | So friends in the central region will notice in the morning |
| 26 | 53.79 | clause | 7 | 48.1–48.7 | 5108 | 643 | 的时候还有太阳， | when there was still sunlight, |
| 27 | 55.32 | clause | 8 | 49.3–49.9 | 5445 | 1728 | 中午的温度还闷热， | The temperature at noon is still humid and stuffy. |
| 28 | 59.02 | forced | 15 | 51.0–53.7 | 5297 | 564 | 下午以后伴随着就有局部的阵雨或 | In the afternoon and afterwards, there will be scattered showers or thunderstorms in some areas. |
| 29 | 60.30 | clause | 5 | 54.0–54.6 | 5683 | 1079 | 雷雨的现象， | The phenomenon of thunderstorms, |
| 30 | 62.39 | sentence | 11 | 54.8–57.0 | 5393 | 583 | 因为锋面云带往南移动了。 | Because the frontal cloud band has moved southward. |
| 31 | 65.44 | forced | 15 | 57.2–60.2 | 5279 | 644 | 不过锋面往南移动的过程当中北方 | However, as the frontal system moves southward, in the north. |
| 32 | 65.83 | pause | 1 | 60.3–60.3 | 5551 |  | 的 |  |
| 33 | 67.90 | clause | 10 | 60.4–62.1 | 5760 | 769 | 高压也开始逐渐的南下， | High pressure systems are also starting to gradually move southward. |
| 34 | 70.59 | forced | 15 | 62.5–64.8 | 5832 | 712 | 而到了天气状况到了明天的晚上的 | By tomorrow evening, the weather conditions will have... |
| 35 | 73.74 | forced | 14 | 65.0–67.2 | 6557 | 974 | 时候，南部地区在白天还是有在三 | During that time, the southern region still had in daytime or something in three |
| 36 | 74.88 | sentence | 7 | 68.0–68.4 | 6497 | 871 | 十一度的高温哦。 | It's eleven degrees, quite warm. |
| 37 | 77.55 | clause | 13 | 68.9–71.3 | 6248 | 670 | 不过到了明天的晚上的时候呢， | However, by tomorrow evening, |
| 38 | 79.43 | clause | 9 | 72.2–73.0 | 6390 | 808 | 随着锋面带往南移动， | As the cold front moves southward, |
| 39 | 81.42 | sentence | 11 | 73.6–75.3 | 6083 | 661 | 这一次南部也有一些降雨。 | This time there's also some rainfall in the southern region. |
| 40 | 83.81 | forced | 15 | 75.5–77.6 | 6250 | 647 | 有的机会不过雨量的部分其实并不 | There are opportunities, but actually the part about rainfall isn't really |
| 41 | 85.90 | sentence | 8 | 77.7–79.1 | 6817 | 626 | 多，零星的一些降雨。 | Scattered rainfall here and there. |
| 42 | 88.91 | forced | 15 | 79.3–82.2 | 6730 | 754 | 因为最重要整个水气的发展呢由北 | Because the most important thing is that the entire water and gas development, you know, is led by the north. |
| 43 | 90.12 | sentence | 4 | 82.4–83.1 | 6981 | 645 | 往南而走。 | Go south. |
| 44 | 93.09 | clause | 12 | 83.4–85.8 | 7333 | 563 | 可是呢天气状况到了礼拜五、 | But the weather situation arrives at Friday. |
| 45 | 95.32 | forced | 15 | 86.1–88.2 | 7121 | 792 | 礼拜六我们要注意的就在于说雨的 | On Saturday, what we need to pay attention to is the rain. |
| 46 | 97.24 | pause | 10 | 88.3–89.9 | 7384 | 738 | 部分会随着锋面带逐渐 | Part of it will gradually move along with the frontal zone. |