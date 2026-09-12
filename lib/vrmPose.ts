import { MathUtils, Vector3 } from 'three';
import type { VRMHumanoid } from '@pixiv/three-vrm';

/** A neutral standing pose, shared by the game view and costume preview. */
export function applyVrmRelaxedPose(humanoid: VRMHumanoid): void {
    humanoid.resetNormalizedPose();
    const armOut = MathUtils.degToRad(14);
    const elbowBend = MathUtils.degToRad(12);

    for (const side of ['left', 'right'] as const) {
        const upper = humanoid.getNormalizedBoneNode(`${side}UpperArm`);
        const lower = humanoid.getNormalizedBoneNode(`${side}LowerArm`);
        const hand = humanoid.getNormalizedBoneNode(`${side}Hand`);
        if (!upper || !lower || !hand || lower.position.lengthSq() === 0 || hand.position.lengthSq() === 0) continue;

        // Normalized bones retain the model's rest directions. VRM 0 and 1 have
        // opposite X/Z axes, so derive the side and forward signs from the rig.
        const outward = Math.sign(lower.position.x);
        if (!outward) continue;
        const forward = side === 'left' ? outward : -outward;
        upper.quaternion.setFromUnitVectors(
            lower.position.clone().normalize(),
            new Vector3(outward * Math.sin(armOut), -Math.cos(armOut), 0),
        );
        lower.quaternion.setFromUnitVectors(
            hand.position.clone().normalize(),
            new Vector3(outward * Math.cos(elbowBend), 0, forward * Math.sin(elbowBend)),
        );

        // Keep palms facing the thighs and relax the fingers without making a
        // fist. Leave the thumb base's authored spread intact.
        for (const [finger, curl] of [['Index', 1], ['Middle', 1.1], ['Ring', 1.2], ['Little', 1.3]] as const) {
            for (const [joint, degrees] of [['Proximal', 12], ['Intermediate', 18], ['Distal', 10]] as const) {
                const bone = humanoid.getNormalizedBoneNode(`${side}${finger}${joint}`);
                if (bone) bone.rotation.z = -outward * MathUtils.degToRad(degrees * curl);
            }
        }
        for (const joint of ['Proximal', 'Distal'] as const) {
            const thumb = humanoid.getNormalizedBoneNode(`${side}Thumb${joint}`);
            if (thumb) thumb.rotation.z = -outward * MathUtils.degToRad(8);
        }
    }
}
